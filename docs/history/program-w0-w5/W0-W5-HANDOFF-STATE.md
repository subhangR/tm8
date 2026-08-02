# tm8 W0–W5 Handoff State

**Date:** 2026-07-26  
**Current wave:** W1 complete; G1 is **USER-WAIVED/AUTHORIZED** after the official migration-runner repair and required green integration suite  
**Implementation waves:** W2 is released for the full-program coordinator to start; W3, W4, and W5 are **UNSTARTED**  
**Authority:** `W0-AMENDMENT-DOSSIER.md` plus `W0-CONSISTENCY-MATRICES.md`; no worker may substitute an older proposal or infer a competing contract

## 1. Immutable handoff facts

- Work only in `/Users/subhang/Desktop/Projects/tm8`.
- Never run git for this program unless a later user instruction explicitly changes that rule.
- W0 made documentation/design changes only. No production, package, migration, UI, or Remote Phase-2 implementation is claimed.
- Delivered source remains 81 catalog rows = 79 v1 + 2 reserved, 80 HTTP + 1 WS, 78 registerable HTTP ceiling, 28 configured semantic HTTP handlers, 43 product migration tables, 13 shipped core kinds, and the tiny legacy CLI.
- The adopted target adds exactly A01–A20. It becomes 101 only after W1 changes the source and generated reachability proof.
- The adopted B1 target keeps v1 `execution.prompt` Server-internal-only, never a public CLI or Member/Teammate capability; the current public handler remains nonconformant until W2 implements the guard.
- The adopted B2 target requires every Teammate-authored live delivery to use one durable unordered pair budget so no thread root or process restart creates a fresh allowance; W1 supplies its storage/lock foundation and W2 implements its API enforcement.
- Server is root, Space is boundary, Workspace is a view, ProjectResource/projection are distinct, session Projects are M:N edges, and `launchProjectId` is provenance only.
- Terminal is always complete/native; Chat is an optional peer; one message store; explicit-only capture; static templates are not entities; immutable profile pin is runtime authority.

## 2. Universal spawn packet invariant

Every W1–W5 worker/reviewer prompt must include:

1. parent/child task ID and exact wave;
2. absolute repository root and owned file list;
3. governing dossier/matrix sections and relevant canonical source sections;
4. shipped-versus-adopted status and exact invariants;
5. deliverables, test commands, non-goals, and collision boundary;
6. no-git rule and report destination;
7. provider/model audit result.

Every GPT-5.6 session must use canonical `provider=openai`, the requested GPT-5.6 model, `reasoningEffort=xhigh`, and `accessMode=fullAccess`. Never run GPT-5.6 through the Claude provider/tool. Claude is used only for an explicitly selected Claude model. A mismatch is stopped and replaced immediately.

**Coordinator polling override:** W1–W5 wave coordinators use a five-minute scheduled polling interval. This cadence is propagated only in coordinator packets, not to workers/reviewers. Immediate blocker, gate-verdict, and completion messages remain event-driven; the 10-minute program heartbeat is unchanged.

**Worker/reviewer packet:** ordinary workers and evidence-only reviewers retain the existing event-driven packet with scheduled polling no more frequent than once per 120 seconds. Do not send the five-minute coordinator cadence as a mid-flight change to a worker or reviewer.

## 3. Wave state

| Wave | Status | Entry gate | Required outcome |
|---|---|---|---|
| W0 | **COMPLETE — G0 APPROVE; G0.1 bound to §6** | user W0 task | exact dossier/matrices, Vega/T-D23 adoption, fresh Opus APPROVE |
| W1 | **COMPLETE — G1 USER-WAIVED/AUTHORIZED** | G0.1 APPROVE plus user-authorized W1 gate waiver | contract/catalog/schema, additive migration/RLS/lock, conformance/generator, identity/system-principal foundations, and official migration-runner compatibility under TDD |
| W2 | **IN PROGRESS — rolling; resumed under §8** | satisfied by the W1 user-authorized G1 close | API implementation by catalog group, including handlers/service/RPC wiring and B1/B2 tests under TDD |
| W3 | **IN PROGRESS — rolling gate authorized to overlap W2; resumed under §8** | user-authorized rolling override recorded in `W3-PUBLIC-AND-AGENTIC-EVIDENCE.md` §1 | independent verification of every W2 group through public HTTP/WS and database-observable outcomes, followed by agentic API discovery/use |
| W4 | UNSTARTED | **fresh G3 APPROVE plus explicit coordinator start** | CLI and harness implementation by group against the contract and a real local Server; no UI or Remote Phase 2 implementation |
| W5 | UNSTARTED | **fresh G4 APPROVE plus explicit coordinator start** | independent real-Server verification of every W4 CLI group plus agentic CLI/harness discovery/use; fresh G5 APPROVE, then program stop and W6 handoff record only |

No later wave may be marked started merely by exploratory reads. Its applicable prior G0–G4 APPROVE entry gate — including the fresh Opus verdict required for every wave by the universal protocol — must be recorded and its child tasks created before the full-program coordinator starts it. W5 ends at fresh G5 APPROVE: record the W6 handoff, but do not start W6 or UI work.

## 4. W1 first-read packet

Read completely before edits:

- `docs/history/program-w0-w5/W0-AMENDMENT-DOSSIER.md`
- `docs/history/program-w0-w5/W0-CONSISTENCY-MATRICES.md`
- `docs/history/program-w0-w5/W0-GATE-REPORT.md`
- `docs/history/program-w0-w5/W0-G0.1-AMENDMENT-REPORT.md`
- `docs/history/program-w0-w5/FINAL-DESIGN-SET.md`
- `docs/history/program-w0-w5/FINAL-DESIGN-SET-REVIEW.md` §7
- `docs/architecture/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` §§0, 2.1–2.3, 5.7–5.8, 7–8.2, 10
- `docs/architecture/DOMAIN-ARCHITECTURE-DECISIONS.md` D16–D17 and §§5–8
- `docs/chat-and-messaging/SESSION-COMMUNICATION-MODEL.md` §§3, 5, 7–10, 13–15
- `docs/harness/AGENT-HARNESS-AND-COMMAND-DISCOVERY.md` §§4–8, 12, 15–17, 20, 22
- `docs/architecture/05-DECISIONS.md` T-D23

W1 must begin by regenerating the operation and kind matrices from source, then prove that every intended difference matches an adopted A-row or frozen-row amendment. Any unlisted difference stops the wave for dossier amendment; it is never silently normalized.

## 5. Standing risks and gates

- The current `execution.prompt` handler uses ordinary caller claims and violates adopted B1 until W2 implements the internal-only guard under TDD; W3 independently verifies the public Member/Teammate/act-as negatives and zero-queue/zero-byte outcomes.
- Delivery/budget/profile/menu/project-projection storage, RLS, locks, and exact delivery-role RPC foundations now exist in migration 015; W2 owns catalog-group API implementation against them, including B2.
- The current live event publisher uses in-memory sequence state; W2 implements stored per-Space replay and semantic WS delivery, and W3 independently verifies them through public HTTP/WS and database-observable outcomes.
- `confirmUntrusted` now exists in the strict contract carrier and is forwarded on supported spawn paths; W2 owns the remaining adopted scratch/profile execution semantics.
- Current CLI tests use a stub rather than a real Server; W4 implements the CLI/harness groups and their real-local-Server integration, and W5 independently verifies every group against a real Server plus agentic CLI discovery/use.
- Prototype/reference-capture constants remain implementation-preparation gates where the dossier labels them; changing a frozen constant requires recorded evidence and an amendment.
- The Opus W1 packet in `W0-GATE-REPORT.md` §8 contains thirteen non-blocking documentation/regeneration cleanups. In particular, workspace §5.7 needs the explicit sanitized profile projection cross-reference and DOMAIN §9 scores need dated scope/re-derivation. Matrix row 47/A16 metadata are corrected only through W1 regeneration because post-verdict edits would rotate the approved matrix hash.
- UI implementation and Remote Phase 2 are outside W0–W5. After fresh G5 APPROVE, stop and record only the W6 handoff; do not begin UI work.

## 6. G0 record

Fresh evidence-only Claude Opus 5 session `sess_1785036862149_jx2k5cx86` returned **APPROVE** with zero unresolved blocker and zero unresolved major, read-only with zero edits/git. The verdict binds to:

```text
b852e62bf6da09aaa9adb65e21c80362082c083db77b87ea829d27f0a1e5c278  W0-AMENDMENT-DOSSIER.md
fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  W0-CONSISTENCY-MATRICES.md
```

Any later dossier/matrix edit rotates the hash and requires a different fresh Opus gate before implementation continues.

### G0.1 narrow amendment record

W1 stopped at its pre-edit authority check. W0-E then froze `spaces.default_interaction_profile_id uuid NULL REFERENCES interaction_profiles(entity_id) ON DELETE RESTRICT` on `spaces.settings_revision integer NOT NULL DEFAULT 1`, with the dossier's exact same-Space/live/active-validation/not-retired, human owner/admin, lock, revision, null-backfill, RLS/RPC, no-op, and rollback laws. It also reconciled the delivery DB boundary to exactly `reserve_session_message_delivery`, `claim_session_message_delivery`, and `settle_session_message_delivery`; the one governed PTY write is non-DB and grants no graph authority.

```text
b852e62bf6da09aaa9adb65e21c80362082c083db77b87ea829d27f0a1e5c278  W0-AMENDMENT-DOSSIER.md (former G0)
b85a18304f3769ba88da67403a7d90331a17c6355df7b451d650b49990434805  W0-AMENDMENT-DOSSIER.md (G0.1)
fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  W0-CONSISTENCY-MATRICES.md (unchanged)
```

Fresh evidence-only Claude Opus 5 session `sess_1785040472762_0wsb78pdj` is the binding reviewer. Its final task verdict is incorporated by reference under the rule stated in the masthead: only APPROVE with zero unresolved blockers/majors records G0.1 and releases W1; any other outcome leaves W1 paused. The W1 coordinator preserved one intentional red contract test, zero migration/DB changes, and four isolated identity files with focused 6/6 green; it must resume from that boundary and re-run its broader checks rather than assuming implementation completion.

## 7. G1 user-authorized record

W1 finished strict contract/catalog/schema foundations, migration 015 with RLS/locks/backfill/repair/compensation and exact three-RPC delivery isolation, generated conformance accounting, identity/system-principal seams, and Server compatibility with explicit 501 boundaries for W2-only behavior.

The final official migration-runner repair is bound to migration SHA-256 `9f3258054fb1a0a3cbc80928edcea87760715f2402671534bd32a232773b5ee7`. Its regression passes empty 001–015 and current 001–014→015 ledger paths. The final generated conformance manifest is `062ec620b8f9be87bc0a96f3bb30e900d0befff540b37e2ddc3ff418c3b9ce5a`; the final packages/migrations digest using the published recipe is `5f1a6ace0566d4bff0fbbef48c66a2a189207eb8dc53c96c7d4bcd8eeac88e0d`.

Required final checks passed: contract 42/42, conformance 12/12, root typecheck, static/raw migration check through 015, official runner 2/2, DB foundations 15/15, and Server 208 tests with 64 separately gated skips while excluding only the live-sidecar fixture already covered by the new official-runner regression.

The user explicitly waived the fresh W1 Opus gate to prioritize functional progress. This waiver applies only to G1. W2 is authorized for immediate coordinator start; future G2–G5 Opus requirements remain in force unless separately overridden.

## 8. M-1 model-substitution amendment (2026-07-27)

**Trigger.** The GPT-5.6 provider became unavailable to this program: the Codex model
entitlements were reset and the prior Codex-backed sessions were terminated mid-flight.
The user authorized continuing the program on Claude only, and directed
**"spawn only opus 5."**

**Adopted substitution.** `IMPLEMENTATION-ORCHESTRATION-W0-W5.md` §2 is amended for
W2–W5. Every role below now spawns as canonical `provider=claude`, `agentTool=claude-code`,
`model=claude-opus-5`, `accessMode=fullAccess`:

| Role | Superseded model | Adopted model | Reasoning effort |
|---|---|---|---|
| Program and wave coordination | `gpt-5.6-sol` xhigh | `claude-opus-5` | `xhigh` |
| Implementation / code modification | `gpt-5.6-sol` xhigh | `claude-opus-5` | `xhigh` |
| Independent API/CLI verification | `gpt-5.6-terra` high / `claude-sonnet-5` | `claude-opus-5` | `high` |
| Low-complexity/grunt work | `gpt-5.6-terra` medium | `claude-opus-5` | `medium` |
| Wave gate review | fresh `claude-opus-5` | unchanged | narrow review prompt |

**What is NOT relaxed.** Independence is enforced by *session*, not by model. An
implementation session may never verify its own work; a verifier may never edit
production source; the gate reviewer must still be a fresh, evidence-only session that
never implemented. The universal spawn packet, the no-git rule, package-disjoint
ownership, public-boundary evidence, TDD red-first discipline, and the G2–G5 fresh-Opus
gate requirements are all unchanged. Recorded provider audits in prior evidence documents
remain historically accurate for the sessions they describe and are not rewritten.

**Adopted team members.**

```text
tm_1785091986509_qebvn6dn2  tm8 W2 Coordinator Opus       coordinated-coordinator
tm_1785091986796_aiatw3m39  tm8 W3 Coordinator Opus       coordinated-coordinator
tm_1785091987091_id0qite2j  tm8 Opus Impl xhigh           coordinated-worker
tm_1785091987382_089qna7hk  tm8 Opus Tester               coordinated-worker
```

The superseded `tm8 Sol xhigh`, `tm8 Terra Tester`, and the five `gpt-5.6-sol` wave
coordinator team members must not be spawned for the remainder of this program. A spawn
audit that reports `provider=openai` is now invalid and is replaced immediately.

### 8.1 Resumption state at the substitution point

The prior W2 and W3 coordinator sessions died mid-wave. Their last written evidence is
`W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md` and
`W3-PUBLIC-AND-AGENTIC-EVIDENCE.md`. **The working tree contains uncommitted work
that those documents do not fully describe** — in particular `entity-kinds-profiles`
(G12) handler/service/test/migration-027 files and `menu-default-channel` (G14)
handler/service/test/migration-029 files exist on disk with no recorded freeze verdict.
Every resuming coordinator must therefore begin with a read-only preflight triage that
re-derives group state from the working tree and a real test run, and must never assume a
group is complete because a file exists. Nothing on disk may be deleted or reverted to
"clean up"; unrecorded work is triaged and either finished or explicitly quarantined with
evidence.

### 8.2 Resumption spawns (2026-07-27)

Full-program coordinator `sess_1785091827417_6km0f26dv` resumed the two live waves:

```text
sess_1785092145056_w4oq8qoel  W2 API Implementation Coordinator   task_1785034451639_y52nw6141
sess_1785092163476_4on0tyohq  W3 Public+Agentic Verification Coord task_1785034451796_fhqepjeyl
```

Both are `provider=claude`, `agentTool=claude-code`, `model=claude-opus-5`,
`reasoningEffort=xhigh`, `accessMode=fullAccess`. Both were ordered to complete a
read-only preflight and report before spawning any worker. W3 was additionally ordered to
run a regression sweep of the seven already-PASSED public suites, because the ungated
G12/G14 work on disk (migrations 027 and 029) landed after those verdicts were recorded.
A regression in a previously-passed group is a stop-the-line event.

W4 and W5 were UNSTARTED at this point; W4 was subsequently released by amendment M-2 below.

## 9. M-2 parallel-W4 amendment (2026-07-27)

**Authority.** The user explicitly directed that the W4 CLI/harness wave start immediately,
in parallel with the live W2 and W3 waves, rather than waiting for a fresh G3 APPROVE.

**What M-2 grants.** W4 may implement the CLI and harness now. This is defensible because
the CLI is *generated/bound from the frozen contract catalog*, not from W2's handlers: the
catalog has been stable since W1 at 101 rows = 99 v1 + 2 reserved, 100 HTTP + 1 WS,
registerable v1 HTTP ceiling 98, digest
`sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604`. CLI groups 1
(global grammar/auth/output/errors/mutation IDs), 10 (help/completion/generated discovery),
and 11 (harness bootstrap/scoped credentials/lazy discovery) are contract-driven and depend
on no handler at all.

**What M-2 does NOT grant.**

- **G4 is not waived.** W4 still requires all CLI group/unit/integration tests green against
  a **real local Server**, with help/completion and JSON output matching the contract. The
  legacy stub-Server tests are exactly the deficiency W4 exists to remove and are not G4
  evidence.
- **G3 is not waived.** W3 retains independent ownership of API verification.
- W4 may not treat an unverified API as proven. Real-Server integration coverage extends
  only to operations W2 has actually **composed**, measured from `/health`, never predicted.
  If W3 later finds a defect in an operation the CLI binds, the binding may have to change.
- W5, UI, and Remote Phase 2 remain out of scope.

**Ownership boundary (hard).** W4 owns `packages/cli/**` and its named harness surfaces
exclusively. W4 must never edit `packages/server/src/**`, `db/migrations/**`,
`packages/contract/src/**`, `packages/server/test/w2/**`, or `packages/server/test/w3/**`.
A contract or server change is **reported for arbitration**, never made by W4. W2 was
instructed to treat an observed W4 edit to server source or a migration as stop-the-line.

**Consumer change.** W2's PUBLIC-READY tranche handoffs now serve two consumers — W3 for
gating and W4 for widening CLI integration coverage — and must be sent to both.

```text
sess_1785093404712_3h87437sp  W4 CLI + Harness Implementation Coordinator  task_1785034451951_r513micgx
tm_1785093306656_y4lqppl3u    tm8 W4 Coordinator Opus                      coordinated-coordinator
```

W5 remains UNSTARTED and still requires its fresh G4 APPROVE entry gate.

### 9.1 Host capacity event (2026-07-27)

Both the W2 and W3 coordinators independently declared a stop-the-line environmental
blocker: `/System/Volumes/Data` was at 100% capacity with ~280 MiB free of 460 GiB, against
a cost of ~11–14 MiB per scratch database. Under user authorization the full-program
coordinator deleted **regenerable caches only** — Chrome cache, npm `_cacache`/`_npx`, bun
install cache, `codex-runtimes`, `uv`, `firebase`, `giget`, `pkg`, Homebrew, `node-gyp`,
`pnpm`, `dotslash` — reclaiming roughly 10–12 GiB. `~/Library/Developer/CoreSimulator`
(8 GB) was deliberately **not** deleted: it had been described to the user as Xcode
DerivedData and on inspection proved to be iOS simulator runtimes, so the discrepancy was
surfaced rather than acted on. It remains an untouched second reserve.

Standing hygiene for every wave regardless of free space: `--no-file-parallelism` always,
one vitest process per session, tear down scratch databases every run, abort and report
below 150 MiB free, escalate to the full-program coordinator below 200 MiB, and announce
DB-backed runs across coordinators so transient scratch databases are not misread as leaks.

## 10. M-3 ruling — per-operation availability is permanent (2026-07-27)

**Escalation.** W3 established, and independently verified rather than accepting from its
tester, that **nothing in the pipeline states a falsehood** but that discovery exposes **no
per-operation implemented/available signal at all**. `registered` in the generated manifest
means *mounted*, not *implemented*, and has meant that since W1. The only machine-readable
split is `/health`'s aggregate `implemented` count, which names no operations. An agent
planning from discovery alone therefore cannot tell which of the 98 mounted operations will
actually do work.

**Question.** Is the refusal message `operation <name> is not implemented on this node`
literal — may nodes legitimately vary — or vestigial phrasing that disappears at G3?

**Ruling: LITERAL.** Per-node capability variation is a designed, first-class concept, not a
build-in-progress artifact. Verified in source, not assumed:

- `docs/remote/PHASE-2-REMOTE-SERVER-INTEGRATION.md` §4.1 — "The Server advertises its stable
  identity, contract version, **capabilities**, and the Spaces visible to the authenticated
  account."
- §5 operation list — `execution.spawn    when capability permits`.
- §5 — "Remote access **changes**: … Capability availability", while operation names, entity
  DTOs, Space membership semantics, and the error taxonomy explicitly do **not** change.
- §11 freeze-requirement 6 — "Capability discovery and contract-version negotiation".
- `packages/ui/src/real/workspace/Unavailable.tsx` — the UI already models this per
  operation at runtime via `isUnavailable(method)` and `disabledBecause(<operation>, …)`.

**Consequence.** The residual set shrinks to zero as W2 composes, so the discrepancy would
have self-resolved at G3 *by coincidence* while leaving the design need unaddressed. The
discovery/help projection must therefore carry a **per-operation availability flag as a
permanent first-class field**, not a scaffold deleted at G3.

**Disposition.** Routed to **W4** (discovery/help projection, groups 10 and 11). Explicitly
**not** routed to W2: a production Server discovery/help/manifest route remains superseded,
W4 may not add a Server surface, and W2 was instructed not to build a capability surface on
its own initiative nor to accept a request for one directly from W4. The data-source
question is open; W4 must propose the minimal mechanism in preflight, and any Server-side
requirement returns to the full-program coordinator for arbitration and may require a
dossier amendment. The generated manifest's unused `reason` field — populated for the two
reserved operations, null for the residual set — is the existing candidate mechanism.

**Not a G15 failure, not a Server defect, not a manifest falsehood. G3 is not gated on it;
it is a G4/G5 deliverable.**

**Mechanism approved (W4, 2026-07-27):** CLI-side derivation, no Server change, no new
operation, no dossier amendment. Permanent first-class fields
`availability: 'available'|'unavailable'|'unknown'`,
`availabilityReason`, `availabilitySource: 'contract'|'observed'|'advertised'`, populated in
strict precedence: contract (the two reserved rows, offline, node-independent) → observed
(an honest `501` *is* the per-operation signal, and W3 proved it is pre-validation, reserves
no `clientMutationId`, and partially applies nothing) → advertised (reserved slot for a
Phase-2 node capability set). `/health` is used **only** as a cache-invalidation epoch, never
as a per-operation claim, and is kept distinct from `capabilityEpoch` so implementation is
never conflated with authorization. Default is `unknown`, never optimistically `available`.
Stated limitation, accepted: an agent planning from a **cold** cache still cannot tell which
mounted operations will do work. Only a node-advertised capability set fixes cold planning;
that is recorded as a **W6/Phase-2 handoff requirement**, not a W0–W5 deliverable.

> **⚠ CORRECTED 2026-07-27 (§21.3): the paragraph below describes the permission axis using PROPOSAL
> language, not the frozen contract.** `PaletteAction` carries **no `allowed` and no `reasonCode`** —
> `reasonCode` occurs **zero** times in the whole contract schema file (`PaletteActionSchema`,
> `schemas.ts:1716`). Those fields exist only in `AGENT-HARNESS-AND-COMMAND-DISCOVERY.md` §7.5 as
> *"should return"*, and the repo had already recorded at `AGENT-JOURNEY-WALKTHROUGH.md:747-748` that
> `actions.list` **as implemented computes structural availability, not authorization**. Verified
> independently by both waves. **The three-axis model stands as DESIGN; the permission axis is NOT
> DELIVERED on this build.** The error is in this ruling's own text, written by the full-program
> coordinator and inherited by W4 in a packet from it.

**Superseded axis confusion, recorded so it is not rediscovered:** exposure
(`public|composite|internal|reserved`, static, contract-level), availability (per-node), and
permission (`actions.list` → `allowed` + `reasonCode` + `capabilityEpoch`, per-actor) are
three orthogonal axes. `reasonCode` is exactly `ROLE|STATE|TRUST|ASSOCIATION|POLICY` and has
no not-implemented member, so permission cannot be made to answer availability; an operation
can be implemented-but-forbidden or unimplemented-but-permitted. They stay separate fields.

## 11. Live corrections to the program record (2026-07-27)

**11.1 Composed surface is 100/73, not 100/62.** Tranche-v2 composed G02. Measured:
`facade/index.ts:102` registers the G02 handlers; `registry.size` 68 facade (57 + 19 − 8
replaced); `/health` `{ok:true, operations:100, implemented:73}`; residual **25**; reserved 2.
`facade/index.ts` rotated `58ff8b7f…df76` → `e46a4cc5…4998`. Every `implemented: 62` /
`residual: 36` figure earlier in this document and in the W2/W3 evidence documents is
superseded. Replacement-not-duplication is **structural**, not merely counted:
`HandlerRegistry.register()` throws on a duplicate name, so the 8 legacy inline registrations
had to be deleted for composition to boot at all. The residual risk is therefore *behavioural
drift* in those 8 replaced operations — which no count can catch and which W3 must test.

**11.2 `bun run typecheck` type-checks NO test file, anywhere.**
`packages/server/tsconfig.json` sets `"include": ["src"]`, so `tsc -b` never sees `test/**`,
and vitest transpiles without type-checking. This is not theoretical: type-checking a
worker's own test files separately against `tsconfig.base.json` caught a real `TS2322` that
both vitest and `bun run typecheck` sailed past.
**Honest consequence: the "root typecheck green" claim in every evidence packet this program
has produced — W1's, I01's, W2's, and the full-program coordinator's own triage — was
overstated as to tests.** It is not withdrawn as to `src`; it never covered `test`.
Standing rule from 2026-07-27: every packet in every wave requires a **separate** typecheck
of the worker's own test files against `tsconfig.base.json`, reported as a distinct result.
Widening any `tsconfig` `include` is deliberately **deferred** to its own scoped task gated
after G3, so it cannot drop every pre-existing test file under `tsc -b` at once and
destabilize frozen, W3-gated work.

**11.3 The W1 migration runner test does not cover the current chain.**
`w1-migration-runner.test.ts` stops at migration **015** — its two cases are "applies 001–015
from empty" and "applies 015 over a runner-ledger current 001–014". It does **not** exercise
019, 027, or 029. The gate that proves the full 26-migration chain is
`test/db/w2-migration-order.pg.test.ts`. §7 above records "official runner 2/2" as G1
evidence; that is accurate for what it measured and must **not** be read as covering the
current chain.

**11.4 An invalid inference the program has run on since W1.** W2's X01 worker found that
migration 020's undo-token inverse allowlist is a CHECK constraint enforced **at INSERT** on
the token row (`operation in ('edges.delete','entities.move','entities.restore')`).
`internal.issue_undo_token` (`004:181`) inserts into `undo_tokens`; `place_entity`'s **embed**
branch (`018:387`) calls it with `'messages.delete'` inside the same transaction as
`post_message`. So under the real 26-migration chain, `placements.apply` with `embed` may fail
outright with `23514` and **roll back the posted message** — not merely mint an unredeemable
token, which is what both the W2 brief and the prior coordinator's ledger assumed.

Five gates missed it. `test/db/w2-edges-placements.pg.test.ts` applies only `001–015 + 018`
and never applies `020`, so the constraint is absent from G03's fixture; no G03 or G05 fixture
exercises `018` and `020` together; and W3's recorded G03 public PASS covers the *non-embed*
normalization path. Nothing had ever exercised embed placement against the full chain.

The structural defect is the inference itself:

> "every migration applies in sequence" (the chain gate)
> **+** "each group passes against its own migration" (per-group PG fixtures)
> **⇒** "every operation still works once every later migration is applied"

**That inference is invalid.** Cross-migration constraint interactions live exactly in the
gap, and every group in this wave was proven inside it. Consequences, ruled 2026-07-27:

- W2's per-group PG fixtures are **isolation proofs, not coverage proofs**. Every W2 evidence
  packet must state which migrations its fixture applies, and no packet may cite a per-group
  fixture as operational coverage under the full chain.
- **No full-chain smoke gate is built in W2.** W3's public harness already applies every
  migration present and runs the production `bootstrap()` — the vehicle exists and is the gate
  of record. A second implementer-authored copy would be a weaker duplicate that would start to
  look like coverage evidence.
- **New standing W3 requirement:** every group's public gate must exercise each distinct
  *branch* reachable from its operations, not merely one path per operation, and every W3
  verdict must state which migrations its harness applied.
- **W3 owns a gap analysis:** enumerate operation branches never exercised under the full
  chain, prioritizing branches that (like `embed`) invoke a shared internal routine whose
  constraints live in a *different* migration than the group's own.
- G03's recorded PASS is a **coverage hole in the verdict, not a false verdict**. It is not
  reopened. The embed branch was never in its scope.

## 12. G0.2 amendment batch (open)

Per the §6 masthead rule, any dossier/matrix edit rotates the approved hash and requires a
different fresh Opus gate before implementation continues. Rather than spend a gate per
field, amendment candidates are **batched** into one dossier revision and one fresh narrow
Opus gate, **G0.2**. Open candidates:

1. **A10 `messages.delivery.get` silent truncation.** `MessageDeliveryQuerySchema`
   (`schemas.ts:1218-1221`) carries `cursor` + `limit` (1..100) and is frozen, but
   `MessageDeliveryViewSchema` (`:1237-1240`) is a bespoke `{message, deliveries[]}` with no
   `nextCursor`, and the SQL uses `limit N` rather than `N+1`. The operation silently
   truncates at 50 and the cursor input is **unreachable by construction**. The dossier §3
   names the DTO pair but §4 never defines the view's fields, so it is genuinely *silent*,
   not contradicted.
   **Ruled: add `nextCursor: CursorSchema.nullable()` to the view alongside `deliveries`, and
   go to `N+1`.** Do *not* restructure into `pageOf()` — it is a composite, not a plain page.
   Rejected alternatives: removing the cursor input would delete a field from a frozen,
   W1-gated strict input schema (a strictly larger amendment) and perturb strict-schema
   conformance accounting; accepting as-is would leave a parameter that can never be
   satisfied, which is the dishonest-surface class this wave has eliminated everywhere else.
2. **Viewer-relative field frozen into a replay snapshot.**
   `internal.w2_space_settings_view` computes `space.unreadTotal` per-viewer via
   `internal.identity_id()`, and the entire projection is frozen into `command_ledger` for
   byte-identical replay (deliberate, documented at `029:307`). A replay of the same
   `clientMutationId` by a *different* owner/admin therefore returns the first caller's
   `unreadTotal`. `029:307` justifies freezing membership, invites, axes, menu, and profile
   defaults — all Space-relative — and does not mention the one viewer-relative field.
   Severity is **low** (requires two owner/admins of the same Space; discloses one integer).
   Candidate law: a viewer-relative field must not be frozen into a replay snapshot, since
   byte-identical replay and per-viewer computation are contradictory. **Amendment prep
   requires an inventory of every other frozen ledger projection for viewer-relative fields**
   before the law is stated generally rather than narrowly.

**Required before the batch closes:** a *measured* impact analysis — whether the catalog
digest `sha256:df96ff5a…` changes (expected unchanged, since it hashes `OPERATIONS` and
schemas are separate; W3's agentic evidence chain and W4's contract binding are both bound to
it), whether the generated conformance manifest `062ec620…` changes, and which frozen seam
hashes rotate and therefore unbind which W3 verdicts. **No implementation of either item
begins before G0.2.** G04 remains frozen with item 1 disclosed; W3 gates the *current*
behaviour.

## 14. SEC-1 — ledger-replay authorization bypass (2026-07-27, open)

**Calibration first: nothing is deployed.** There is no production tm8 node and no user data at
risk. The posture is *must be fixed and proven before anything ships*, not incident response. No
wave stopped.

**Defect.** `internal.ledger_replay` is keyed on the caller-supplied `client_mutation_id`
**globally** — not by identity, Space, actor, or input. `public.w2_update_space`, the RPC behind
`spaces.update`, returns that replay with **zero authorization**:

```
016:83-84   replay := internal.ledger_replay(cmid,'spaces.update');
            if replay is not null then return replay; end if;    ← bare return, no authorization
016:113     perform internal.require_space_admin(p_space_id);    ← 29 lines too late
```

So an authenticated caller with **no membership of the target Space**, supplying a
`clientMutationId` an admin already used, is handed that Space's stored projection — name,
description, `githubRepo`, and the viewer-relative `unreadTotal`.

**Five sites return a replay before authorization** (INV-1 swept 119 executable
`internal.ledger_record()` sites across 14 migrations):

| # | RPC / operation | Site | Status |
|---|---|---|---|
| 1 | `w2_update_space` / `spaces.update` | replay `016:83`, auth `016:113` | **G01 — composed, W3-PASSED** |
| 2 | `set_space_default_channel` | `029:619`, auth `029:564` **before** | G14 — uncomposed; narrowest |
| 3 | `grant_stream_attach` / `execution.streams.attach` | `007:2195`, auth `007:2197` | execution surface |
| 4 | `join_public_space` / `spaces.invites.redeem` | `007:569` | **G01 — composed, W3-PASSED** |
| 5 | `redeem_invite` / `spaces.invites.redeem` | `007:657` | **G01 — composed, W3-PASSED** |

**#4 and #5 share the operation string `'spaces.invites.redeem'`**, so their cmids interchange
**across two different RPCs** without tripping the operation-mismatch check — a second,
independent failure mode.

**The defence already existed, in exactly one file.** `023_w2_inbox.sql` alone pins the cmid to a
principal before replaying, raising `23514 'clientMutationId belongs to another principal'`
(`023:102-107`, `023:189-194`). Three weaker variants exist (`024` re-checks member ownership,
`019:388-397` compares an identity-salted hash, `020:66-77` re-authorizes the undo actor). **The
codebase converged on this guard four separate times and never generalized it** — four accidental
survivors of one missing law, and #1 did not get an accidental survivor.

**Rulings.**

1. **Scoped fix task against frozen G01 `db/migrations/016` authorized** (and `007` pending
   INV-2). Its own task and session, red-first at the SQL layer, full-chain fixture. It rotates
   migration 016 and therefore **unbinds G01's public and agentic verdicts**.
2. **Generalized guard adopted, staged.** `023`'s principal-pinning becomes the stated law and a
   shared helper: *a replay may not be returned to a principal other than the one that recorded
   it.* **Stage 1** = helper + the four confirmed pre-authorization sites. **Stage 2** = remaining
   sites after INV-2, evidence-driven. **At every site the worker must ask whether cross-principal
   replay is ever legitimate there and justify the answer in writing** — a system-principal or
   delivery-adapter path may legitimately cross principals, and a mechanical sweep must not assume.
3. **Tranche-v2 PUBLIC-READY is amended, not retracted.** The defect is in W1-era `016`/`007`,
   predates tranche-v2, and is in nothing I02 composed. The amendment naming the affected
   operations is written into the declaration itself, not only the ledger, because W3 and W4 both
   consume it.
4. **G01's verdicts are a coverage hole, not a false verdict** — the same standing treatment as
   G03/embed. Retraction is reserved for a verdict that was *wrong about something it actually
   tested*.

**RESOLVED — it is publicly reachable. W3 executed it, did not infer it.**

```
POST  /v2/spaces            → Space A 019f9fff-d014-73b2-9840-9d9341b9eb25
POST  /v2/spaces            → Space B 019f9fff-d02f-7596-9da1-10c12818b9e6
PATCH /v2/spaces/{A}  cmid='w3-xg01-shared-replay-cmid'  → 200, A's projection
PATCH /v2/spaces/{B}  SAME cmid                          → 200, NO ERROR, returns SPACE A's id and name
```

A request that **addressed Space B received Space A's identity and stored projection**. The facade
does not constrain the cmid. Test held deliberately RED at
`packages/server/test/w3/xg01-ledger-replay-authz.test.ts`. Root cause independently reproduced:
`internal.ledger_replay` (`004:103`, redefined `012:66`) selects `where client_mutation_id = p_cmid`
with **no identity, Space, or actor predicate** — only an operation-name check. **Non-vacuous:** a
companion case passes — the same cmid under a *different* operation is refused ≥400 with no write —
so the ledger *is* consulted. This is an authorization-ordering bypass, not a skipped ledger.

**Disclosed limit of the proof, which does NOT lower severity.** W3 proved the **space-binding**
bypass and executed it; it could **not** prove a cross-**identity** leak publicly, because Phase-1
identity is a single loopback auto-owner and there is no second principal at the HTTP boundary —
both Spaces belong to one owner. W3 flagged that asymmetry itself rather than letting its red read
broader than it is. Ruled: severity is not reduced, because the identity predicate is *genuinely
absent* from `004:103`/`012:66`, so the non-member case follows from the code rather than from
optimism, and Phase-2 remote plus multi-member Spaces supply the second principal.

**The fix ruling was amended because principal-pinning alone is insufficient.** W3's red is
**same-principal** — one owner, two Spaces — so 023-style principal-pinning would leave it failing.
Returning Space A's row to a request naming Space B is wrong *even for the legitimate owner*.
**Amended law: the guard binds the replay to the PRINCIPAL *and* the ADDRESSED RESOURCE.**

**This is a violation of an already-frozen law, not a gap.** The W3 acceptance matrix (§4 of
`W3-PUBLIC-AND-AGENTIC-EVIDENCE.md`) already requires of every accepted group: *"mutation-ID
reuse with changed frozen intent fails according to the operation contract."* A `spaces.update`
addressed to Space B is not the same intent as one addressed to Space A. Therefore the
resource-binding half needs **no dossier amendment** and **G0.2 does not grow**; only the
principal-pinning half is a genuinely new stated law.

**Targeted brake (full-program coordinator's, not W3's).** Nothing is deployed, so a full stop buys
no safety and costs three waves. Implementation continues everywhere — G13, G12-AUDIT, G10, G11,
INV-2, the SEC-1 fix, and W3's G02 gate all run. **But W2 may not compose a new tranche (v3) until
SEC-1 Stage 1 is frozen and W3 has independently verified it**: composing more groups while this
defect class is unswept expands the vulnerable surface without expanding safety. Tranche-v2 stands,
amended. **W3's block on recording G3 readiness is affirmed.**

**Gap-analysis class D3, added by W3 and neither coordinator had framed it:** *a shared routine
invoked **before** the caller's authorization, where the routine returns caller-influenced data.*
This one is **not cross-migration at all** — `016` calls `004`; it is call-**order** within one
function. Division of labour: W2 owns the systematic SQL-layer sweep (INV-2, 137 `ledger_replay`
sites, `016:83` as positive control); W3 consumes that output and builds **public negatives** for
whatever it finds in composed groups.

**W3's own assessment, recorded verbatim because it is the justification for the whole gap
analysis:** *"That is TWO gated groups in one session whose unexercised branch was found by someone
else's inventory rather than by my gate. That is a statement about MY gate, not about W2's
implementation… my per-operation coverage was never per-BRANCH coverage."*

**RESOLVED — severity input. Guessability was the wrong axis.**

Canonical severity phrasing, adopted program-wide:
**"Reachable, and not self-serving *today* — but self-serving the moment G04 composes."**
The tense is load-bearing. **"cmids are unharvestable" is forbidden phrasing** — true today, false
on the next tranche.

The CLI is *not* the weak link: `uuidv7` seeded from `node:crypto` `randomBytes` (74 bits of CSPRNG
entropy — state the number, not "it's a UUID"), and `deriveMutationId(root, stage) =
sha256('tm8/mutation/' + rootId + '/' + stage)` takes **no attacker-visible input** (no file name,
checksum, entity id, timestamp, or counter). Derived stage ids are as unguessable as the root;
disclosure of one root yields that upload's stage ids by computation.

**But the contract publishes cmids as ordinary readable fields, by design.** Dossier `:296`
verbatim: *"Each row keeps one immutable `anchor_id` and nullable `message_batch_id =
clientMutationId`"*; `:45` (m10) classifies it as *"a nullable correlation column, not an
entity/table"*. Also `019:491`, `019:6`, `contract.ts:93`, `schemas.ts:164`/`:542`. And dossier A05:
`clientMutationId: string; // handoffId exactly` → `HandoffViewSchema.handoffId` (`schemas.ts:1280`).
So the exploit's precondition is a **read**, not a guess.

**Why two waves reached opposite conclusions, and both were right.** W3 swept eleven composed read
projections for a recorded cmid and found **zero**, non-vacuously. But it recorded its marker via
`entities.create` — a **non-message** entity where `messageBatchId` is null by construction — so its
probe *structurally could not* surface the message path. True negative for the path probed, silent
on the other.

**The exact coupling (traced by W2):** the `message_batch_id` column exists from `015`; **only
G04's `019` populates it** from the cmid; composed `messages.post` is a **501 stub**
(`handlers/messages.ts:175-182`); but the composed **read** path is already wired
(`entity-read.ts:583` projects `messageBatchId`). The gun is loaded and pointed — **G04 pulls the
trigger.** Composing G04 simultaneously activates cmid publication through composed reads that
already hold a W3 PASS (`entities.get`, `entities.children`, `collections.query`, `messages.list`)
and does nothing about the replay defect. `handoffs.list`/`handoffs.send` compound it.

**Brake extended and specific: G04 must not compose until SEC-1 Stage 1 is frozen AND
W3-verified.** Not merely tranche-v3 in general.

**A proposed law was withdrawn.** The full-program coordinator floated *"clientMutationId MUST be
unguessable"* as belt-and-braces. **W4 argued against it — against its own group's convenience — and
was right.** It is (i) *unsatisfiable by construction*, since the same dossier mandates
`messageBatchId == clientMutationId` and `handoffId == clientMutationId` and publishes both; and
(ii) *dangerous in the comfortable direction*, sitting in the dossier looking like defence-in-depth
while providing none, and licensing exactly the inference that must not survive — *"cmids are
unguessable per the law, so pre-authorization replay is low severity."* Same shape as the
`unreadTotal` under-alarm.

**Adopted into G0.2 instead, in W4's words, endorsed by W2:**
> `clientMutationId` is a correlation identifier, **not a capability**. It is published in read DTOs
> by design (`messageBatchId`, `handoffId`). **No authorization decision may depend on its secrecy.**

This makes principal-plus-resource binding **the only defence** — which is correct, because it does
not depend on cmid secrecy at all.

**Governance fix — the M-1 audit surface.** `maestro whoami`/`status` expose only
mode/sessionId/projectId/task, with no provider, agentTool, model, reasoningEffort, or accessMode.
A **worker therefore cannot mechanically verify its own M-1 compliance** and can only self-report.
Ruled: **the M-1 audit obligation sits with the spawning coordinator**, who verifies the team-member
record (`maestro team-member get <id>`) *before* first use and records the result in the freeze
evidence. The worker's self-report is corroboration, not the audit.

**Method worth reusing.** INV-1 found #1 only because a literal accessor grep *would have missed
it* — `internal.current_member_id` resolves identity without naming an accessor. It built a
**transitive taint closure** (63 seeds → 184 identity-derived functions, converged in 3 rounds) and
**named its own limit**: the closure covers `db/migrations/*.sql` only, so a projection enriched in
the TypeScript facade layer is **not** covered and completeness above the DB boundary is not
claimed. That disclosed boundary is as valuable as the finding — it says where to look next.

**Provenance.** This was found by a read-only inventory scoped for the *unrelated, low-severity*
`unreadTotal` question (§12 item 2), because the instruction asked for **extent** rather than
accepting one instance. The full-program coordinator classified `unreadTotal` low-severity and
batched it; that was right about item #2 in isolation and wrong to let "low severity" close the
question of extent. **Asking whether a defect is a class or an incident is what converted a batched
footnote into a live-surface finding.**

## 14A. SEC-1 class verdict and the shared-guard ruling (2026-07-27)

**INV-2 swept all 114 `ledger_replay` sites.** Corrected figures — the first-reported "32 defended"
was *arithmetic, not enumeration*, and was wrong in the direction that understated exposure:

```
114 textual  =  91 EXPOSED  +  20 DEFENDED  +  3 non-disclosing
16 dead code
LIVE = 98    =  78 EXPOSED  +  20 DEFENDED
72 live-exposed with 031 landed
```

Use **91/20 textual, 78/20 live**. The earlier 79/32 was propagated repeatedly by the full-program
coordinator. Fourth instance of the same class in one session: **the reassuring number was the
computed one** — which is precisely what the named-second-reader rule exists to catch, since the SAFE
half of the pair was the half nobody had counted.

52 exposed sites are directly facade-invoked. Six **frozen** groups carry
exposed sites — G01(15), G02(33), G03(5), G04(9), G06(8), G14(3). Five are clean — G05, G07, G08,
G09, G12.

**The framing inverts.** Not *"does G12's defect generalise?"* but **"G12 found and fixed, in one
migration, a defect six other groups still carry."** G12 was one of the five that got it right.

**Worst two — privilege escalation, not disclosure:**
- `007:583 create_invite` — the stored jsonb is `to_jsonb(space_invites)` **including the live invite
  `code`**, and `redeem_invite(p_code)` consumes exactly that code to grant membership. Replay one
  cmid → valid invite code for a foreign Space → **become a member.** Both operations are **G01:
  composed and W3-passed.**
- `021:227-229 update_project_w2` — `return replay` on one line, `internal.require_node_admin()` on
  the **next**. Any authenticated caller with no node-admin, no membership, and no Space obtains a
  node-wide Project record including `working_dir`, an absolute host filesystem path.

**Three retractions, one of which had propagated.** (i) G14 is **EXPOSED**, not "the narrowest case"
— its guard authorizes on the *caller-supplied route argument*, never the ledger row. (ii) The
canonical severity phrasing named too few groups; corrected to **"reachable; not self-serving today
only because all four cmid-publishing read surfaces sit behind uncomposed groups — G04, G10 and G13.
Composing any one of them makes it self-serving."** (iii) "74 bits of entropy" was a CLI property
read as a system property.

**A live oracle exists today:** `ledger_replay`'s `23514` interpolates the cmid **and the true
owner's operation label** into message text reaching the wire verbatim (`016:34-37` →
`db/errors.ts:82` → `http/errors.ts:89`). It upgrades guessing to **guided search**. Removal is in
Stage 1b.

**The shipped UI generates cmids with zero random bits** — `useThread.ts:34` is
`` `cmid_${Date.now().toString(36)}_${mutationSeq}` `` with the counter resetting every page load,
driving composed `readMarks.upsert`; `GraphCanvas.tsx:202` is a pure function of two readable entity
UUIDs. The contract does not constrain the value at all: `schemas.ts:613-645` is
`clientMutationId: z.string().optional()` — no `.min(1)`, no regex, no length bound. **So
"unguessable" was never true of the system as shipped** — third independent confirmation that
principal+resource pinning is the *only* defence, not defence in depth.

**Severity, stated with its limit:** for `create_invite` specifically the chain is a **plausible
end-to-end privilege escalation on today's composed surface**. It is built from verified source facts
and is **not yet an executed result**; W3 owns the measurement and was told not to upgrade it on the
coordinator's wording.

**Composition brake now names G04, G10, G13 and G14.**

### 14A.1 Ruling — fix the law where the law lives

`internal.ledger_replay` already selects the ledger row, and `command_ledger` carries
`identity_id` (`004:81`). **The principal comparison is three lines inside the shared function and
closes all 114 sites at once.** Approved.

*The deciding argument on blast radius inverts the main objection:* the alternative is **79 per-site
edits under frozen, W3-gated groups** — a strictly larger radius across more files, authors, and
review surface. Three lines in one shared function is the *smaller* change. Doing the wrong thing
carefully 79 times is still doing it 79 times. It also makes the defence **structural rather than
per-author**: a group written next month gets it for free.

Ruling details:
- **New migration `032`, not `031`.** `031` has landed and been announced; editing it would rotate
  the chain digest *without a new file* — the invisible-rotation problem, and the drift class the
  runner's immutability rule exists to prevent.
- **Fail-closed, written explicitly** — not as an incidental consequence of `is distinct from`
  semantics. **Nothing is deployed, so there are no production ledger rows to preserve; fail-closed
  costs nothing today and would be a genuine tradeoff in six months. Take it while it is free.**
  Required first: determine whether `ledger_record` can ever write a NULL `identity_id`. If it can,
  that is **stop-and-report**, not silent fail-open.
- **Identity only, never actor.** Exact `actor_id` equality would raise `23514` on a legitimate retry
  with a different Teammate selected, or with the actor claim absent under background retry or
  delivery-adapter re-drive.
- **A purpose-built negative is required** — a test whose *purpose* is to find a legitimate
  cross-principal replay, exercising the enumerated nested-call paths (`018:337,357,361,375,382`;
  `020:104,113,119,132`), plus a mutation test of the guard itself. Static analysis plus existing
  suites is not a test written to look for the risk.
- **Additive, not a substitute.** `ledger_replay` cannot know the addressed resource, so it cannot
  carry the resource half; W3's same-principal/different-Space red remains the acceptance criterion.

**Sequencing: split.** Stage 1 continues exactly as scoped (six sites + resource binding) because it
carries the only executed public red. **Stage 1b** takes `007:583`, `021:227`, the `23514`
interpolation removal, and the `032` guard. Stage 2's plan is written *once*, after `032` lands —
with the principal half closed globally it becomes "which sites still need the resource half", and a
site whose stored subject *is* the route argument may be resource-bound by construction. **Enumerate
that subset; do not assume it.**

### 14A.2 Single-source propagation — a second failure mode

Distinct from false corroboration (§15.5) and needing a different countermeasure:

| Failure mode | Shape | Countermeasure |
|---|---|---|
| **False corroboration** | N authors, one mechanism | *"Could these have disagreed, given how each was produced?"* |
| **Single-source propagation** | one reader, stated confidently, quoted onward by many | ***"Who has actually READ this, versus who is quoting me?"*** |

The G14 "narrowest case" claim was read once, mis-classified, stated with confidence, and travelled
to three coordinators and a fix worker with nobody re-deriving it — **precisely because it was the
reassuring item in a list of alarming ones.** W2 had written the exact warning against this into
INV-2's own packet and then made the error anyway: **knowing the trap is not protection against it;
the protection is a second reader.**

**Standing rule: any claim that a site is SAFE requires a named second reader.** Alarming findings
attract scrutiny; reassuring ones do not.

**Carried to W6:** `019:1136 w2_prepare_handoff` is safe only by a **coupling invariant, not a check**
— a future retention job deleting `session_handoffs` while `command_ledger` persists would make it
the worst site in that file.

## 15. Instrument defects — verify the instrument, not just the result

Four structural defects in the program's own *measuring apparatus* were found on 2026-07-27, all by
workers, none of them product defects. They are recorded together because they share one shape:
**a proxy was measured and the property was recorded.**

**15.1 `bun run typecheck` type-checks no test file** — see §11.2.

**15.2 The full-chain inference** — "migrations apply" + "each group passes against its own
migration" ⇏ "operations work under the full chain". See §11.4.

**15.3 Measurement-validity defect in the G15 gate (self-reported by W3).** Its classifier probed
every operation with **no body**. For a command operation an empty body fails `INPUT_SCHEMAS`
validation and returns **400 before the handler is reached**, so the classifier read "not 501" and
recorded "implemented" — never reaching the stub. **`messages.post` is an unconditional 501 stub
(`handlers/messages.ts:175-182`) and was counted as implemented.** All **64 non-GET v1 operations**
were probed this unrepresentatively.

*Both halves are affected, not one.* The 25 residual are true positives, but the set is not
exhaustive — `messages.post` returns 400 to a no-body probe and 501 to a valid one, so the true
"501 on valid input" set is ≥26. Overstated-implemented and understated-residual are the **same
error seen from two sides**, and `73 + 25 = 98` held only because the two errors were equal and
opposite. **That arithmetic identity is what made the error invisible: it looked like a
reconciliation and was a tautology.** Reconciling to a ceiling proves two numbers came from one
partition, not that the partition was correct.

*The distinction that matters:* `/health implemented:73` reports `registry.size` — **registered**
handlers. **Registered ≠ behaviourally implemented.** Every declaration must now state which it
means. This is the same conflation W3 had earlier corrected *in its own tester* (establishing that
"registered" has meant *mounted* since W1) and then made in its own assertion.

*Disposition:* residual half stands; **implemented half withdrawn** pending re-measurement with
schema-valid bodies; the G02 verdict is **held** so it does not inherit the conflation; the
rebuilt probe must enumerate every operation **registered but returning 501 on valid input**,
distinguishing genuine stubs (`messages.post`) from honest conditional refusals
(`entities.create`/`patch` on an unsupported kind — DEV-13 behaviour, arguably correct).
**Not a product defect:** `messages.post` returning 501 is honest for an uncomposed group. The
instrument was wrong; the system was right.

**15.4 `npx vitest` from the repo root silently runs a different project's vitest.**

```
npx vitest --version                                → vitest/1.6.1   ← WRONG, resolved from a SIBLING project outside the repo
packages/server/node_modules/.bin/vitest --version  → vitest/2.1.9   ← correct
ls node_modules/.bin/vitest                         → No such file or directory
```

There is no root-level vitest binary, so `npx` walks **up and out of the repository**. That runner
reports **"No test suite found" for every file in this repo** — confirmed even for files that are
green under the correct runner. **This is evidence integrity, not ergonomics:** a worker can bank a
"red" that is really *wrong runner found no tests*, satisfying a red-first requirement with a
meaningless artifact, or read "no tests" as "nothing to run" and skip a suite. Either produces a
clean-looking packet with nothing underneath it.

**Correct invocation:** `cd <package> && ./node_modules/.bin/vitest run --no-file-parallelism <path>`,
or `bunx vitest` from **inside** a package. Required verbatim in every packet; all three waves
audited their workers' reported commands — **all three came back clean**, and reporting the clean
result was required, because a silent audit is indistinguishable from an unrun one.

**The general rule (verified, and broader than "vitest is the trap"):**

```
ls node_modules/.bin/   →  tsc
                           tsserver          ← exactly two entries
npx tsc --version       →  5.9.3             ← resolves INSIDE the repo — SAFE
npx vitest --version    →  vitest/1.6.1      ← resolves OUTSIDE the repo — WRONG
```

**The repo root `node_modules/.bin` contains exactly `tsc` and `tsserver`. Every other binary
invoked via `npx` from the repo root resolves outside this repository** — at whatever version a
neighbouring project pins. vitest was not special; it is simply the one that was hit. Any future
tool reached for from the root has the same problem.

**⚠ Superseded refinement — `npx tsc` is safe only from INSIDE the repo.** The earlier form of this
rule ("`npx tsc` is correct, don't over-correct") was itself under-scoped and was broadcast
program-wide before being corrected. Verified from a scratch directory:

```
cd <outside the repo> && npx tsc --version
  → "This is not the tsc command you are looking for"
  → ~/.npm/_npx/…/node_modules/tsc    name: "tsc", version: "2.0.4"
```

There is a real npm package literally named `tsc` — an unrelated, long-deprecated 2.0.4 — and from
outside the repo **npx downloads, caches, and executes it**. This happened on this host during the
session: `~/.npm/_npx` had been cleared entirely during the disk cleanup, so the cache entry was
created afterwards by a worker.

**Corrected rule:** `npx <tool>` resolves correctly **only when resolution starts inside this
repository AND** the tool is one of the exactly two root binaries. From outside the repo, *every*
tool including `tsc` resolves to — or downloads — something else. Safest invocation removes the cwd
variable entirely: `cd <package> && ./node_modules/.bin/tsc -p <absolute-config-path>`.

**This one counterfeits a RED, not a green** (`npx tsc -p …` exits 1 from outside), so it cannot
manufacture a false clean — but a worker can bank "typecheck red", investigate, and find nothing
wrong because nothing was checked. **Audit packets for any instruction that has a worker `cd`
outside the repo before running a tool** — W4 found exactly that shape in its own packets, having
told workers to use "a scratch config outside the package" to prevent tsconfig widening.

Capture the **version banner** in evidence, not just the command — `RUN v2.1.9 …/packages/cli` or
`Version 5.9.3` is proof; naming the command is assurance. (Incidental tell: a real `tsc` emits
diagnostics like `TS2688`, which the 2.0.4 package cannot produce.)

### Scope discipline — the coordinator's own failure mode

> **"A measurement without its conditions is not a finding, it is a rumour with a number attached."**
> Corrective question: ***"Under what conditions did I measure this, and does my sentence say so?"***

Three claims were amplified program-wide by the full-program coordinator without re-deriving their
scope — the G14 "narrowest case", "74 bits of entropy", and "`npx tsc` is safe" — **each because it
was reassuring and arrived with a number attached.** Two of the three were under-scoped at source and
one was simply wrong; all three propagated because nobody asked under what conditions they held.

**Standing rule on the coordinator: before broadcasting any claim program-wide, state the conditions
under which it was measured, or do not broadcast it.** Inability to state the conditions is the
signal that the claim is not understood well enough to relay. Every wave is authorised to ask
"under what conditions?" about anything the coordinator sends.

*Concrete counterfeit, for the record:* the wrong runner against `test/exit-codes.test.ts` — **7/7
green** under the correct runner — produces `Test Files 1 failed (1) / Tests no tests`. That artifact
satisfies a red-first requirement while proving nothing.

### 15.5 Corroboration requires MECHANISM diversity, not AUTHOR diversity

The `73 + 25 = 98` identity was cited four times as independent corroboration. It held **only
because the two errors were equal and opposite** — the implemented count over-counted
registered-but-stubbed operations by exactly the amount the residual count under-counted them. It
was **a tautology wearing the costume of a cross-check**.

> The correct question was not "do the numbers agree?" but **"could they disagree, given how each
> was produced?"**

Four derivations agreed on the split — W2's group decomposition, W3's mechanical catalog-join, the
C01 AST inventory, and `/health`'s `registry.size`. **All four count REGISTRATION.** Four authors,
four codebases, **one mechanism**. They agreed because they measured the same thing, not because the
thing was right. The agreement bought zero additional confidence about *behaviour* — and it actively
suppressed scrutiny, because nobody probed the number *because* it agreed.

**Standing rule.** When N derivations agree, state what each one *measures* before treating the
agreement as evidence.

- Shared mechanism ⇒ **one derivation with N authors**. Still useful — it rules out transcription and
  arithmetic error — but it is **not** independent confirmation of the underlying property.
- Independent corroboration requires a **different mechanism reaching the same property by a
  different route**: static source read vs. executed behaviour; DB-layer observation vs. public HTTP;
  registration count vs. per-operation probe with a valid body.
- Before banking agreement, ask in the evidence: *"could these have disagreed, given how each was
  produced?"* If no, the agreement is structural and proves nothing.
- **Comfortable results get MORE scrutiny, not less.** Four pleasant findings survived unexamined
  today *because* they were pleasant: the `unreadTotal` under-alarm, "cmids are unharvestable",
  "root typecheck green", and `73 + 25 = 98`.

This does not devalue multi-party review: W3 correcting the coordinator's fix specification, W4
arguing the coordinator out of a bad law, and W4's neutral third-party settlement of the digest
dispute were genuinely independent — different vantage, different method, different incentive. Nor
does it invalidate any measurement; G15's catalog-join and the C01 AST inventory were *correct at
what they measured*. **The defect was the inference drawn from their agreement, and that inference
was the full-program coordinator's**, repeated and pushed to all three waves.

**Replication vs. corroboration.** W4 applied the standard to its own already-accepted group-1
freeze and withdrew its own claim: its coordinator rerun and the worker's run were *one mechanism
with two authors* — same suite, same runner, same tree — so they could only have disagreed via
transcription or arithmetic error. That is **replication** (valuable: it rules out exactly that) and
not **corroboration**. Use the two words precisely.

**The form a freeze argument should take** — W4's decomposition, adopted program-wide. List the
mechanisms *and state what each one can see that the others cannot*:

| | Mechanism | Uniquely catches |
|---|---|---|
| M1 | executed behaviour (suite green) | — |
| M2 | causation under perturbation (mutation test: break, observe failure, restore, verify) | a suite that is **green and vacuous** |
| M3 | static type analysis (separate test-file typecheck vs `tsconfig.base.json`) | a suite that **passes while its test files don't type-check** |

Naming each mechanism's unique blind-spot coverage is what converts a list of checks into an
argument.

**A retraction in the reassuring direction deserves the same scrutiny as the original alarm.** A
correction that makes a problem smaller is exactly as capable of being wrong as one that makes it
bigger, and it faces far less scrutiny because everyone wants it to be true. W4 independently
re-verified W2's migration-030 retraction rather than accepting the reversal.

### 15.5a Reproducibility is not validity

The published chain-digest recipe was **cwd-dependent** — it hashed `shasum`'s *output lines*, which
contain the path exactly as typed. The same 28 byte-identical files produced four different digests:

```
from repo root,      db/migrations/*.sql   → 2bbaf608880519ba
from packages/server, ../../db/…           → 41ae15d7b9890cc4
absolute paths                             → 1650abd603a0a378
content hashes only, no filenames          → 3caf82e8c92e21f9
```

A W2–W3 dispute over two of these numbers had earlier been "settled" by W4 reproducing W2's recipe
from an uninvolved third session and matching its number exactly. **It reproduced the bug exactly —
which is what a reproducible recipe does when the recipe is wrong.**

> **A third party reproducing your number confirms DETERMINISM, not CORRECTNESS.**

Cross-session reproduction rules out transcription and environment drift; it cannot detect a recipe
that faithfully measures the wrong thing. It is *replication* (same mechanism, different author), not
corroboration — §15.5 recurring in a place nobody looked. The full-program coordinator had praised
that arbitration as the right way to settle a numbers dispute: right for the question *does this
reproduce?*, but the question that mattered was ***does this measure the property it claims to
measure?***

**The defect class is the hardest to see because the intent reads correctly:** the author argued
*for* binding filenames — correctly, since the runner applies in lexical order, so a rename must
rotate the digest even with no SQL byte changed — and *implemented* it as binding invocation strings.
"I got the property I did not want and lost the one I did."

**Canonical recipe** — verified cwd-independent from four starting directories **and** proved to
retain rename-sensitivity (rename `030` → digest moves; restore → digest returns):

```
(cd <repo>/db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
```

Proving the fixed instrument still detects what the original was *for* is what makes it an adopted
recipe rather than merely a patched one. **Retired as cwd artifacts or superseded:**
`2a969baf9d98f300`, `125b007f6ba268a0`, `6e3593a1d5fa4df6`, `2bbaf608880519ba`, `41ae15d7b9890cc4`,
`1f1ec2afda56bda6`, `6540207bdefd5bb9`.

Verdicts bound under the old recipe are **re-labelled, not re-run**: a bind measured start-and-end
from the *same* cwd still validly proves the tree did not change during the sweep, which is the whole
property. Both labels are recorded with the reason, so a future reader does not mistake the change
for a rotation.

### 15.5b A half-written migration is not inert

W2 stated `031` had been "never applied to any database" — true of `db/migrate.mjs` against
`tm8_dev`, **false of the independent gate**. `startW3PublicServer` applies *every* file matching the
migration pattern, so SEC-1's work-in-progress `031` was applied to every scratch database in W3's
sweep. That is the likely cause of an anomalous G03 2-failure read that returned to 6/6 on a stable
chain — **a mid-write migration injected into the gate, not a regression** — which W3 re-measured
before concluding rather than filing against a group it had already passed.

**Therefore the author-outside-the-repo protocol is not tidiness and not digest hygiene.** Workers
author migrations in a scratch directory outside the repository, iterate freely even during a freeze,
and hand the coordinator path + SHA-256 + shared-object statement; the coordinator verifies and
copies in at an announced landing point. **The directory is quiet by construction rather than by
everyone's continuous good behaviour.**

Related specification lesson: **a "stop doing X" order to a worker whose deliverable *is* X is not an
instruction, it is a contradiction — it needs a redirect, not a prohibition.**

### 15.5c Executable shared-object proof (adopted template)

The strongest form produced, and now required for any new-objects-only claim: apply the full chain
**twice**, with and without the migration, and **diff the entire `public` + `internal` catalog** —
columns, triggers, indexes, policies, constraints, functions — permitting only the declared new
signatures to differ. Then **mutation-test the proof itself** by appending an
`alter table … add column`, watching the catalog diff fail, and reverting.

Strictly stronger than a grep: a grep finds only the DDL forms someone thought to enumerate; a
catalog diff finds anything that changed. A claim carrying this proof may be treated as a declared
no-op with far more confidence than one carrying a grep.

*Verifier trap, which caught two separate audits:* `031:313 grant_row public.stream_grants;` is a
**PL/pgSQL variable declaration, not a GRANT**.

### 15.6 The third verdict classification

The two-way rule (coverage hole / retraction) was insufficient. The full set is now:

| Classification | Meaning | Disposition |
|---|---|---|
| **Coverage hole** | an unexercised branch | verdict stands, closed forward |
| **Retraction** | the verdict was *wrong about something it actually tested* | verdict withdrawn |
| **Measurement-validity defect** | the instrument measured a **proxy**; the record named the **property**. The literal assertion is true; the banked claim is false | **claim** withdrawn, verdict **not** retracted, property re-measured |

**Standing rule: verify the instrument, not just the result.** Every gate must be able to show that
its probe actually reached the thing it claims to have measured.

## 16. Migration immutability (2026-07-27)

`db/migrate.mjs` enforces a **per-file content checksum** (`:137`), detects drift (`:181`, `:203`),
and hard-fails: *"A migration is immutable once applied. Add a new file, or recreate the database"*
(`:206-208`). Editing an applied migration in place is forbidden by the runner's own rule —
`010`/`012`/`013`/`014` already exist as forward-only patches to `004`/`007` for exactly this reason.

**Therefore SEC-1 lands entirely in a new `031`** — shared helper plus all four `create or replace`
redefinitions — leaving `016` and `007` **byte-identical**, with a header naming what it supersedes
(`016:72`, `007:541`, `007:617`, `007:2183`), since a comment in `016` would itself cause drift.
**This does not reduce the retest obligation:** `spaces.update`'s runtime behaviour changes and the
chain rotates, so **G01 needs a fresh W3 public *and* agentic retest regardless of where the fix
lives.**

Verified: `public.applied_migrations` on `tm8_dev` had applied neither `020` nor `027`, so X01's and
G12's in-place edits caused no actual drift on any real database, and scratch databases rebuild from
`migrationFiles()` every run. The rule binds from here.

## 13. Program-wide method standards adopted 2026-07-27

- **Red-substitutes.** When a law already holds and a production red cannot be obtained
  without breaking production, a worker must either (i) **mutation-test** — deliberately break
  the production line under test, show the new case fails, revert, and verify the revert; or
  (ii) **probe-red its own assertion** — feed the case the input that *should* make it pass and
  show it fails, proving the assertion discriminates rather than accepting unconditionally.
  The worker must label honestly which it used. Never manufacture a fake red; never bank a
  bare pass as proof of non-vacuousness.
- **Verify, then file.** A defect hypothesis is traced to its terminating source before it is
  reported. A disproved hypothesis is reported *as a disproof*, because filing working code as
  a defect costs a fix cycle and devalues every real finding afterwards.
- **A verdict is bound to the composition it was measured against.** Every implementation
  handoff leads with the measured seam hash set, and the implementer proactively tells the
  gate when a rotation unbinds verdicts it already holds, rather than leaving it to be
  detected from a file watch.
- **Frozen literals stay literal.** A stale exact-literal assertion is a *detector working*.
  It is updated to new exact literals with before-and-after recorded — never converted to a
  range, a `toBeGreaterThan`, or a value computed from the live registry, which would make it
  pass forever and destroy the detector.
- **Coordinator numbers are correctable by workers.** Three separate worker corrections of
  coordinator figures landed on 2026-07-27 and all three were real.
- **Fixtures are built, not listed.** Every new or modified PG fixture builds its chain from
  `migrationFiles()`, never a hand-listed slice, and carries a count-and-presence guard
  (`MIGRATIONS.length === 26`, sorted official order, named migrations present) so it cannot
  silently narrow and re-hide a cross-migration defect. Every fixture states which migrations
  it applies.
- **Verdicts bind to the migration chain, not only to source seams.** A migration rotation
  unbinds every verdict measured against the old chain exactly as a seam rotation does.
  Implementers announce migration rotations with the chain identity; gates do not detect them
  from file timestamps.
- **Shared-workspace build collisions.** Three waves edit one workspace and
  `bun run typecheck` / `bun run build:server` compile all of it. A failure pointing at a file
  you do not own is almost certainly a sibling mid-edit — re-run, report only if it persists
  across two runs, and never fix a sibling's file. Two identical sweeps disagreeing is the
  *signature* of concurrent edits; **test causation** (revert your change, confirm the failures
  persist, restore, confirm non-causal) rather than assuming blame or innocence.
- **A defect found in one group is evidence about a class, not an incident.** A fix that closes
  the question only for the group where it was found is incomplete.

### 13.1 X01 — embed defect resolved

The §11.4 defect is fixed and frozen at 32/32 (new X01 suite 7/7; G03 **unmodified** 13/13;
G05 **unmodified** 10/10; full-chain gate 2/2 from empty and from 001–015). Migration 020's
allowlist is now exactly four literal operations including `messages.delete`, still an explicit
enumeration rather than a lookup. Both sides were mutation-proved: adding `handoffs.withdraw`
to the allowlist makes the exclusion test fail (the exclusion is non-vacuous), and renaming the
new branch to a never-matching value fails three tests (the branch is load-bearing). W3
independently confirmed the fix at the public boundary and correctly refused to let its PASS be
read as a refutation of the defect, having checked that its run post-dated the fix.

New migration hash: `33915548b445ddd3c15b490e3cbf104c2d6eb5fa367d289fff02e1156b61af2a`.

Redemption is a **state transition, not a destructive delete**: body → `[redacted]`, mentions
and attachments cleared, `redacted_at` set, file `attached_to` edges removed, pending deliveries
cancelled with reason `message_deleted`, exactly one `message.deleted` event, and **thread
history survives**.

**Carried-forward cross-migration coupling for W6:** migration 020 now calls
`w2_tombstone_message`, created in 019. plpgsql does not resolve callees at CREATE time, so a
standalone `001–015 + 020` fixture still applies cleanly — but a future rename of that function
would fail at **runtime**, not at migration time. This is the mirror of the embed shape (a
constraint in a *later* migration breaking an *earlier* caller); both directions belong in the
gap analysis, whose general question is *which cross-migration couplings are invisible to
migration-time validation*.

**Fixture widening is sequenced, not blind.** W3's gap analysis names which fixtures to widen
and in what order; the targeted W2 task is released only when that lands. An undirected sweep
of all fifteen frozen fixtures was rejected as too destabilizing to run without direction.

---

# 17. LIVE RESUMPTION STATE — 2026-07-27, all three waves stalled on usage limits

**Read this section first if you are resuming.** Everything above is durable law and findings; this
section is the volatile state at the moment all three wave coordinators stopped.

## 17.1 Sessions that stalled (all `claude-opus-5`, all hit usage limits)

```
W2 implementation   sess_1785092145056_w4oq8qoel   task_1785034451639_y52nw6141   STALLED
W3 verification     sess_1785092163476_4on0tyohq   task_1785034451796_fhqepjeyl   STALLED
W4 CLI/harness      sess_1785093404712_3h87437sp   task_1785034451951_r513micgx   STALLED
```

**Respawned 2026-07-27 (staggered, because usage limits are the binding constraint):**

```
W2 implementation   sess_1785109435632_1jvbdpuqv   RESUMED — owns the batch landing + G10/G11
W4 CLI/harness      sess_1785109463142_y8s2a410s   RESUMED — groups 2-9, independent of the batch
W3 verification     NOT YET RESPAWNED — deliberately held
```

**Why W3 is held:** it is genuinely blocked until the `027`/`031`-Stage-1b/`032` batch lands — it was
told to hold its bind for one stable target rather than chase three rotations. Respawning it now would
burn limited capacity on an idle gate. **Respawn W3 the moment W2 announces the batch landed**, and
give it: the new chain identity, the instruction to re-bind (its 43/43 and G02 18/20 are UNBOUND), the
`xg01` invite red as the Stage 1b acceptance criterion, G01 + G14 fresh public *and* agentic retests
(no declared no-op — `031`'s six `create or replace` are silent to a catalog diff), and §17.6's
concurrent-harness question.

Team members (M-1, §8): W2 `tm_1785091986509_qebvn6dn2` · W3 `tm_1785091986796_aiatw3m39` ·
W4 `tm_1785093306656_y4lqppl3u` · impl worker `tm_1785091987091_id0qite2j` ·
tester `tm_1785091987382_089qna7hk`.

## 17.2 Chain of record

```
28 files   digest 8c5227dfe17923c2
recipe:    (cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
020 33915548b445ddd3 · 027 477c4dd6140f99a3 · 030 8bbc3e6043840cbc · 031 940f9eb1d5d8e259
```

**RETIRE `ca473b0c…` — that is the RACED `031`.** All seven earlier digests retired as cwd artifacts
(§15.5a).

## 17.3 Group state

**FROZEN ≠ COMPOSED — do not blur these.** *Frozen* = W2's implementation is complete, evidenced and
coordinator-verified (a property of the WORK). *Composed* = registered in the facade and reachable at
the router (a property of the DEPLOYED SURFACE). A frozen group is **not** licence to claim
integration coverage.

> **⚠ CORRECTED 2026-07-27 (§19.3): G10 is PARTIAL, not frozen.** This subsection asserted both
> "G10 frozen-but-NOT-composed" and "Remaining: G10" — both cannot hold. Resolved from a measured run:
> the residual set contains **exactly one G10 operation, `presence.get`**; durable events, WS, and stored
> per-Space replay are **genuinely unimplemented**. G10 is therefore correctly **excluded** from the
> tranche-v3 compose list and remains implementation work. Read every "G10" below as `presence.get` only.

**W2 — frozen:** G01, G02, G03, G04, G05, G06, G07, G08, G09, G12, G13, G14, G15, X01, I01, I02.
**Composed:** only the tranche-v1 seven + G02. **G04, G10, G12, G13, G14 are frozen-but-NOT-composed**
— measured at the router: all `messages.*`, all three `handoffs.*`, all six `interactionProfiles.*`,
all three `entityKinds.*`, `presence.get`, `entities.context`, `entities.feed`, `spaces.menu.get/update`,
`spaces.defaultChannel.set`, and both `*.interactionProfile.setDefault` return 501.
**Remaining:** G10 (events/WS/presence/replay), G11 (execution + session lifecycle, carries B1/B2).
**Composed surface:** 100 mounted / **73 registered** handlers (never say "73 implemented" — §15.3);
behaviourally implemented **at most 72**; 25 residual + 2 reserved.

**W3 — public + agentic PASS:** G01, G03, G05, G06, G07, G08, G09, G15 (8 of 15).
**G02: FAIL** (18/20) — `tracking.refresh` returns 403 on any multi-Space fan-out; fix task
`task_1785098332812_vs927afkc`. **G3 readiness BLOCKED and unrecorded.**
**W3's 43/43 sweep and G02 18/20 are currently UNBOUND** — they were bound to `6848bb5f`, which
contained the raced `031`. Accurate for what they measured; not current.

**W4 — frozen:** group 1 (kernel), 10 (discovery/help/availability), 11 (harness). 3 of 11.
**Remaining:** groups 2–9. Open G4 obligations: **O1** exit 11 end-to-end via
`message send --wait settled`; **O2** exit 130 via a real interrupt.

**⚠ O1 IS ON THE CRITICAL PATH THROUGH SEC-1.** `messages.post` is registered but is the unconditional
501 stub, so exit 11 cannot be proven end-to-end until **G04 composes** — and G04 is behind the
composition brake, which is behind SEC-1. **SEC-1 therefore gates W4's G4, not only W3's G3.** O1 stays
open against G4 regardless of how much CLI lands; synthetic coverage against a stub is not acceptable.

## 17.4 SEC-1 — the open security program

Final tally: `114 textual = 91 EXPOSED + 19 DEFENDED + 1 UNCERTAIN + 3 non-disclosing`;
`LIVE = 98 = 78 + 19 + 1`; 72 live-exposed with `031` landed.

- **Stage 1 LANDED** in `031` (de-raced). W3's `spaces.update` red is GREEN — but see §17.6.
- **Stage 1b AUTHORIZED, not yet authored:** `016:330`/`016:360` `w2_revoke_invite` (**the LIVE one —
  `007:595` is legacy and may be dead**), `007:583` `create_invite`, `021:227` `update_project_w2`,
  three message sites, plus **strip-at-source** `to_jsonb(invite) - 'code'` at all three invite sites.
- **`032`** shared principal pin inside `ledger_replay` — in flight. Fail-closed, identity only, never
  actor. **Open specification gap:** the NULL-vs-NULL case makes the pin *silently inert*; it must be
  proven to FIRE, not merely to not-error.
- **`027` tier fix** — verified, ready.
- **Composition brake:** G04, G10, G13, G14 may not compose until SEC-1 Stage 1 is frozen **and**
  W3-verified. G04 specifically also gated on the cmid-publication surfaces.

**Batch landing pending:** `027` tier fix + `031` Stage 1b + `032` land as **one batch, one published
identity, one re-run each**. W3 was told to hold its bind for that target.

## 17.5 Confirmed live defects, measured at the public boundary

1. **`create_invite` leaks a foreign Space's LIVE INVITE CODE.** `POST /v2/spaces/{B}/invites` with
   Space A's cmid returns 201 containing A's code. **The invite code is a bearer credential** — once
   obtained the attacker never needs the replay path again. W3's `xg01` red is the acceptance
   criterion; SEC-1 is barred from touching that test.
2. **`tracking.refresh` 403 on multi-Space fan-out** (G02) — iteration 1's `bind_actor` poisons
   iteration 2's `resolve_actor` coalesce.
3. **TOCTOU race**, reproduced executably by SEC-1 with a `pg_locks not granted` assertion so a lucky
   interleaving cannot pass as coverage: a non-member received another identity's full Space
   projection — **while all 21 sequential tests passed on that same build.**

## 17.6 ⚠ OPEN QUESTION FOR THE RESUMING COORDINATOR — the `032` independence gap

W3 recorded, unprompted, that its `spaces.update` 409 is a **sequential** measurement and **would have
been green on the raced build too**. So the gate verified the *resource binding* and **cannot
currently verify concurrency ordering at all.**

**Consequence:** `032`'s entire purpose is race-correctness across all 114 sites. If the gate cannot
test races, **`032`'s core property would rest solely on its author's own test** — independence
satisfied in form, failing in substance.

**Direction given, ruling not yet issued:** W3 to scope a concurrent harness **prioritised for `032`
specifically**, not for re-verifying `031` (SEC-1's two-connection test already covers that; a second
sequential pass adds nothing). If the harness is expensive, the cost comes to the full-program
coordinator rather than being absorbed silently. **This is a gate coverage gap, not a criticism of
SEC-1.**

## 17.7 Late rulings not yet reflected above

- **A REPLAY TIER MUST EQUAL ITS LIVE TIER** — G12-AUDIT's replacement for a catalog-diff it
  *refused*, correctly, because `027`'s edit is the create-or-replace-at-identical-signature class the
  template is silent on. A **tier matrix** across all nine ledgered operations, with a positive half so
  the guard cannot pass by refusing everyone. It kept the knowingly-red test **out of the shared tree**
  while three gates ran against it — land it with the batch.
- **"The first authorization call is not the authorization tier."** `propose`'s first call really is
  `require_space_member`; its *effective* tier is stricter via an inline actor-kind check further down.
  A reader matching first-call-to-first-call sees a match. Third instance of one lesson:
  **authorization is a property of the whole path, not of the first statement that looks like a check.**
  The fix extracts the live tier into one function both paths call — no "first call" to match, no
  second statement to drift.
- **Batching vs bind-coherence are complements, not substitutes.** Publishing the identity in the same
  action as the copy does not remove the residual, because a worker can sample between copy and
  publish. **Batching makes rotations rare; bind-coherence makes them harmless — and only the second is
  under the worker's control.**
- **Verify an edit against its DELTA, never the whole file.** Grepping all of `027` hit a
  `create trigger` and revokes from its *original* body; only the 63-line delta showed the truth.

## 18. M-4 — two-coordinator closure topology (2026-07-27)

**Trigger.** Every subsession died. The staggered respawns recorded in §17.1
(`sess_1785109435632_1jvbdpuqv`, `sess_1785109463142_y8s2a410s`) are **also dead** — `maestro status`
showed one active session, the full-program coordinator's own. Treat §17.1's respawn block as
historical.

**User directive, 2026-07-27.** Resolve **everything in waves 1–3 to a close**, run **W4 in parallel**,
have both coordinators **work together**, and complete the program **through W4**. Additionally: every
task in waves 1–3 must end up **marked complete in maestro**, not merely finished on disk.

**Adopted topology.** Three wave coordinators become **two**:

```
sess_1785111933513_162e35vc8  W1–W3 Closure Coordinator  task_1785034451639_y52nw6141
                              tm_1785111712197_19o6gpy1s (created for this role)
sess_1785111942109_1yb56hwg1  W4 CLI + Harness Coordinator  task_1785034451951_r513micgx
                              tm_1785093306656_y4lqppl3u
```

Both `provider=claude`, `agentTool=claude-code`, `model=claude-opus-5`, `reasoningEffort=xhigh`,
`accessMode=fullAccess`. M-1 team-member audit run by the full-program coordinator **before** first use,
per the §14 governance fix: all four adopted members confirmed `claude-opus-5` / `claude-code` /
`active`. Both were cross-introduced by session ID with their mutual obligations, and both were ordered
to complete a read-only preflight and report **before spawning any worker**.

**W2 and W3 now share one coordinator, and the independence law is unchanged.** §8 stands verbatim:
**independence is enforced by session, not by model.** The closure coordinator therefore **neither
implements nor verifies** — it spawns *disjoint* implementation and verification worker sessions, and
no worker session may both implement a thing and gate it. `packages/server/test/w3/xg01-ledger-replay-authz.test.ts`
remains **barred to every SEC-1 implementation worker**: the implementer does not edit the test that
judges it.

**Why one coordinator for both waves is defensible rather than a weakening.** W3's remaining critical
path runs *through* W2 — it cannot publicly gate an uncomposed group, so tranche-v3 composition is its
blocker, and the batch-landing/re-bind handshake that stalled twice was a two-coordinator negotiation.
Collapsing that handshake into one session removes the coordination failure mode without touching the
worker-level independence that actually supplies the evidence.

**Task-hygiene rule, stated so it cannot be read as licence to bulk-close.** A task is closed only
against evidence in a ledger document (`W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md`,
`W3-PUBLIC-AND-AGENTIC-EVIDENCE.md`, `W4-CLI-IMPLEMENTATION-EVIDENCE.md`). Stale-status tasks
whose work is finished and evidenced are closed against that evidence; genuinely-open tasks are
finished first. **An item that cannot close is reported `blocked` and escalated — an honest blocked is
worth more than a dishonest complete.** A completed status with nothing behind it is the same
counterfeit-clean-packet class as §15.4's wrong-runner red.

**O1 is the named exception to "complete through W4."** Exit 11 end-to-end stays **open against G4**
until G04 composes, which is behind the SEC-1 composition brake. W4 was told not to build synthetic
coverage against the 501 stub and not to let O1 quietly disappear from its G4 statement. **W4's G4 is
therefore gated by the other wave's security work, and that dependency is structural, not schedule
slippage.**

**W5 remains UNSTARTED** and still requires its fresh **G4 APPROVE** entry gate. The user's "through
W4" direction does not start it. W5 = independent real-Server verification of every W4 CLI group plus
agentic CLI/harness discovery and use, ending at fresh **G5 APPROVE**, after which the program **stops**
and records only the W6 handoff. UI implementation and Remote Phase 2 stay out of scope.

### 18.1 Rulings on the W1–W3 closure preflight (2026-07-27)

Both coordinators reproduced the full-program coordinator's baseline exactly — 28 migrations, digest
`8c5227dfe17923c2`, `032` absent, ~18 GiB free. W2 suite measured green by the closure coordinator's
own run: `RUN v2.1.9 …/packages/server`, 14 files / 156 tests, 156 pass. `025`/`026`/`028` being absent
is **not** a gap to fill: a new migration takes the next number above the highest existing file,
because the runner applies in lexical order and a backfill is an out-of-order insert against any ledger
that already applied `027`/`029`.

**C1 — the pin is `033`, not `032`. The full-program coordinator's packet was one renumbering out of
date.** Plan of record on disk: **`032` = per-site Stage 1b, `033` = shared principal pin,
`034` = `027` tier fix.** The renumbering is **load-bearing, not cosmetic**:
`test/db/w2-sec1b-ledger-replay-principal-pin.pg.test.ts:62` detects landing via
`migrationFiles().some(f => f.startsWith('033_'))`, so landing the pin as `032` would leave that suite
applying its out-of-repo candidate **on top of** the landed chain and reporting green forever — a
counterfeit-green generator.

**C2 — `031` already pins 12 sites.** ⚠ **The "108" in this ruling was WRONG; the figure is 92 —
see §19.4 ruling 5.** The full-program coordinator computed `114 textual − 6 pinned` while leaving all
**16 dead-code sites in**, when the enumerated LIVE figure was already recorded at §14A.1's tally.
*"The number I broadcast was the one I computed rather than the one I enumerated."* The corrected split is
**98 live effective − 6 pinned = 92 unpinned**, reached independently by a tester's static parse arriving
at INV-2's LIVE figure **by a different route** — genuine corroboration, not replication. Verified by grep of the landed
file rather than quoted: one definition, one comment, and 12 `perform` sites in **6 pairs**
(`:246/:255`, `:358/:367`, `:426/:435`, `:510/:519`, `:614/:624`, `:743/:753`) — a pre-check fast path
plus one inside the replay branch under the already-held advisory lock. §17.6's concurrent harness is
therefore scoped to **the 108 unpinned sites**; SEC-1's two-connection `pg_locks` test genuinely covers
the 6 pairs and a second sequential pass over them adds nothing. **Always carry the figure with those
conditions attached** — a bare "108" is the rumour-with-a-number-attached shape.

**This was the fifth worker correction of a coordinator figure in this program, and the fifth that was
real. The record now contains no instance of a coordinator figure surviving a worker challenge.** That
base rate is itself a finding: it says re-derive, not trust.

**C3 RULED — the `027` tier fix lands as new migration `034`, never in place.** The tier work itself is
right (it extracts `internal.w2g12_profile_draft_principal` as the single tier function both the live
and replay paths call — exactly the §17.7 remedy); only the landing mechanism was wrong.

*The argument that makes it unconditional is the disclosed LIMIT, not the obvious reasons.* The closure
coordinator could not read `applied_migrations` on `tm8_dev` (psql needs a password it does not have).
§16's rule is "immutable **once applied**" — a rule whose **trigger is appliedness**, which it cannot
evaluate. **A rule whose precondition you cannot determine must be applied as though the precondition
holds:** treat every migration in the tree as applied somewhere, always, and patch forward. Deliberately
**not** resolved by obtaining the password — the forward-only patch is correct regardless of the answer,
and making the decision depend on an unmeasurable fact is worse than an extra file. Reinforcing: the
delta is all `create or replace` of functions with no table/column/index/policy DDL, structurally the
same shape `010`/`012`/`013`/`014` already use to patch `004`/`007`; and landing in place reproduces
verbatim the invisible-rotation problem that §14A.1 cited when it ruled `032`-not-`031`.

**Mandatory condition on `034` — ORDERING CLOBBER, which nobody had priced.** `033` declares itself
**not** new-objects-only: 114 RPC bodies change on their replay path. `034` is currently authored as a
modified copy of `027`'s **original** body. Migrations apply in lexical order, so **`034` runs after
`033`** — and if any G12 profile function is among the bodies `033` rewrites, `034`'s
`create or replace` from the original text **silently reverts `033`'s pin on exactly those functions**,
un-pinning them while every file-level check and every grep of `033` still shows the pin present. A
security regression introduced by a correctly-motivated tier fix, **invisible to any file-based
instrument**. Required: author `034` against the **post-`033`** definitions; prove absence of clobber
**from the database catalog after applying the full chain** by counting and locating
`require_replay_principal` sites in live `pg_proc` bodies, not in files; and state in writing whether
any function `034` replaces is touched by `033`, with the enumeration. A "no overlap" answer is a
**SAFE claim** and needs a **named second reader** per §14A.2.

**C4 — the SEC-1b fixture-integrity guard cannot fail.** Flagged in the *reassuring* direction, wearing
a convincing justification comment.
`w2-sec1b-ledger-replay-principal-pin.pg.test.ts:230-237` replaced the §13 exact count literal with two
assertions that are undetectable by construction: `:91` sets `APPLIED_MIGRATIONS = migrationFiles()`,
then `:232` asserts `toEqual([...migrationFiles()].sort())` — **comparing `migrationFiles()` to
`migrationFiles()` sorted**, proving only that the helper returns sorted output, while the comment at
`:84-88` claims it asserts the not-a-hand-listed-slice property "directly and more strongly"; and
`:236` `toBeGreaterThanOrEqual(28)` is **monotonic**, since migrations are only ever added. §15.5's
tautology-wearing-the-costume-of-a-cross-check, recurring **inside a security suite's own integrity
check** — the most expensive possible location for a vacuous guard.

The worker's motive was legitimate (an exact count on a security suite becomes a spurious red the moment
a sibling lands a migration), **so the remedy is not restoring the literal**: read applied filenames
back **out of the database** and compare to `migrationFiles()` — two sides, two mechanisms, genuinely
able to disagree. Fixed by a session that is **not its author**. **Required addition: mutation-test the
replacement** — narrow the fixture to a hand-listed slice, show the new assertion goes red, restore,
confirm green. Otherwise one unfalsifiable guard has been replaced by a second unverified one that
merely looks more convincing. **Monotonic-by-construction assertions are now a named class** (two
instances produced so far).

**`033`'s proof instrument.** Because `033` is honestly declared not-new-objects-only, §15.5c's catalog
diff is the **wrong** instrument and demanding it would only yield a proof that cannot pass; the
blast-radius replay regression replaces it. **Sharpened the way §17.7 sharpened the tier matrix: it
needs a POSITIVE half** — a legitimate same-principal replay must still return byte-identical output
across all nine ledgered operations — **or the pin passes by refusing everyone**, satisfying every
negative test ever written.

**NULL-PRINCIPAL independence upheld.** The `033` suite had already absorbed the silently-inert analysis
that §14A.1 requires to be answered **before** the pin is authored — i.e. the requirement had been
quietly pre-empted by the very session it exists to constrain, and **the pin's author has an incentive
for the answer to be "no NULLs."** Kept as a **disjoint** session; the `033` suite's own analysis counts
as corroboration only if it is a different **mechanism**, which must be stated before agreement is
banked. Reachable NULL `identity_id` is **stop-and-report**, never a silent fail-open.

**M-1 audit is TWO-SURFACE — §14's governance fix named a surface that cannot discharge it.** Both
coordinators independently reported that `maestro team-member get` exposes Name/Role/Mode/Model/Agent
Tool/Permission Mode/Scope/Status but **no `provider` and no `reasoningEffort`**, and both correctly
declined to assert flat "M-1 compliant". The missing surface is the **spawn-time echo**:
`maestro session spawn --launch-config …` prints back `Provider: … / Model: … / Intelligence: … /
Access: …`. Neither half suffices alone — record gives model/agentTool/mode/status, echo gives
provider/effort/access. Pass `--launch-config` **explicitly on every spawn** rather than relying on
team-member defaults for the two fields the record cannot show, and capture the echoed lines verbatim.
**Residual limit, adopted as the honest phrasing program-wide:** *"model and agentTool from the record,
provider/effort/access from the spawn echo, no surface confirms the running session's actual effort."*
**A RESUMED session produces no fresh echo, so for resumed sessions provider and effort are
unverifiable from any surface at all** — assert model/agentTool and say so plainly.

**Stray artifact.** A 0-byte file named `940f9eb1d5d8e259` sits in the **repo root** — a shell-redirect
accident from the digest recipe (that string is `031`'s hash). Correctly not deleted, though §8.1
protects unrecorded **work product** and a provably empty redirect artifact is not that; the reason to
leave it is that nobody here runs git and there is no benefit to touching it. **Recorded here so
whoever eventually commits does not sweep it in with `git add -A`** — that is the actual risk.

**Fan-out approved as submitted:** ten disjoint slots, no file owned twice, sole migration landing point
is the coordinator, `xg01` barred to every SEC-1 implementation session. Staged **A (NULL-PRINCIPAL) +
C (G02-FIX) + G (concurrent harness)** first — the spec prerequisite, a confirmed live defect
independent of the batch, and the longest-lead verification item that blocks nothing if it stalls.
Staging is not caution; usage limits are the binding constraint that killed every prior session.

### 18.2 Rulings on the W4 preflight (2026-07-27)

Instruments captured with banners: `RUN v2.1.9 …/packages/cli`, 19 files / 289 tests all passing;
`tsc` `Version 5.9.3` (real, not the `tsc@2.0.4` package). **`packages/cli/node_modules/.bin` contains
`vitest` locally, unlike the repo root** — which is why the local-binary form is safe inside that
package and the root trap does not apply there. Real Server came up inside the suite —
`[harness] http://127.0.0.1:57123 operations=100 registered=73`, `[harness] chain bind-start
28/8c5227dfe17923c2` — so **the real-local-Server harness works**, which is the deficiency W4 exists to
remove.

**C1 ACCEPTED — groups 5, 8 and 9 had NO TASK AT ALL, and the full-program coordinator's §5.1 closure
list silently omitted three of the eight remaining groups.** Mechanism of the error, named because it is
this program's own recurring defect relocated: **the work list was built by enumerating existing maestro
tasks instead of by enumerating the eleven-group decomposition**, so it inherited the tracker's gaps and
presented them as complete. A **proxy** was measured (the task list) and the **property** was recorded
(the remaining work) — §15's class, sitting in the coordinator's work inventory rather than in a test.
**Standing rule: THE TRACKER IS AN INSTRUMENT, NOT A SPECIFICATION.** Enumerate work from the spec and
reconcile the tracker to it, never the reverse. Aggravating detail: the three omitted groups were
message/handoff (owns **O1**), event/presence, and session/execution/profile (owns **O2**) — **a closure
list that omitted both of the wave's own closure blockers.**

Duplicate reconciliation: 8 tasks covered only 5 groups. Group 2 `task_1785100351215_bj7y2cuw9` ≡
`task_1785109983686_zx82nzuxn`; group 4 `task_1785100351505_5e39ap7f8` ≡
`task_1785109992625_71qn82hle`; group 6 `task_1785100351790_ibdjmdh5r` ≡
`task_1785109994739_fj4ybhenz`; group 7 `task_1785100352187_j1vnzwa0i` and group 3
`task_1785109986278_bm68ihagt` single. **Keep the Slot D/E/F/G task in each pair** (each is bound to a
live session already holding a complete packet, and Slot E's seam ruling is recorded against its task);
close the three `task_17851099*` duplicates **as duplicates, naming the surviving task ID** in each
closing summary so a later reader follows the merge rather than concluding work vanished.

**C3 ACCEPTED — O2 was blocked by a MISSING TASK, not by a gate.** "Not blocked, close it" was ruled
from the gate dependency alone without asking what a 130 proof physically requires: a genuinely
long-running command to interrupt, and the only registered candidate is `execution.streams.attach`
(`event watch` is a WS skeleton). O2 lands in **group 9**. Addition: exit 130 is fundamentally a
**signal-handling property of the CLI kernel**, not of any operation, so a harness-injected slow
transport with a real SIGINT can exercise the same path — but that is a **§13 red substitute** and must
be **labelled**, with the gap stated: it proves the kernel's signal path, **not** 130 under interruption
of a real in-flight server operation. Prefer the real interrupt; never record O2 CLOSED on the
substitute without the qualifier.

**C4 ACCEPTED — W4 groups 2–9 are ZERO LINES.** `src/commands/` contains only `completion`, `help`,
`kind`, `registry`, `search`, `worker-init`; `registry.ts` still carries the eight domain spreads as a
comment ("Domain modules land here"). "Executing" in the packet and ledger §5.1 was **inherited from a
status field, not measured**. All four wave-2 sessions are **ALIVE** holding full packets, but every
prompt they received was answered `You've hit your session limit · resets 5:10am`. **3 of 11 frozen
stands (1, 10, 11) and the 289 tests are entirely theirs.**

**RESUME the four warm sessions rather than respawning** — they hold complete packets, the reset has
passed, and respawning re-burns the same budget for the same content when budget is the binding
constraint. Two required additions: **(a) an immediate one-line ACK from each resumed session before it
starts work** — the identified hazard is that *a limited worker is indistinguishable from a thinking
one*, so silence counterfeits progress; an ACK converts silence from ambiguous into diagnostic, the
cheapest instrument in the program. **(b)** the resumption-specific M-1 limit above.

**C2 — a model of "verify, then file".** The ledger records `packages/cli` at 288 tests, the tree
measures 289. Before reporting a candidate cross-wave violation, W4 checked for a **mechanism**: newest
mtime under `packages/cli` is `test/integration/harness.ts` at 02:43, **43 minutes before** the 03:26
blocker, and `packages/contract/src` is untouched since 07-26 14:41, so no catalog-driven test could
have regenerated either. **The +1 has no mechanism in the tree: a slip in the record, not a W1–W3 edit.**
Filed as a **disproof**, no stop-the-line, and recorded so a later reader does not "discover" a phantom
violation.

**NEW NAMED DEFECT CLASS — an evidence requirement naming a string the tool cannot emit.** The wave-2
packets mandate `bunx vitest` and demand the banner as `vitest/2.1.9`, **which the tool never prints**.
This is worse than a wrong command: it **trains the worker to approximate** — it must either fabricate
the string or paraphrase what it actually saw, and either way the banner requirement is dead while still
looking satisfied. The banner rule exists to make evidence unforgeable; specifying an impossible string
inverts it into a forgery prompt. **Adopted program-wide: every required evidence string must be copied
from a real observed run, never composed by the packet author.** Replacement requires the **full RUN line
including the trailing path** — `v2.1.9` alone is consistent with the wrong runner, whereas
`RUN v2.1.9 /Users/subhang/Desktop/Projects/tm8/packages/cli` proves resolution happened inside this
repository.

**Reconciled non-overlapping slot map — the unit of ownership is the MODULE, not the noun:**

| grp | files owned exclusively | integration class |
|---|---|---|
| 2 | `space.ts`, `identity.ts` | G01 composed + W3 PASS → REAL |
| 3 | `entity.ts`, `task.ts`, `tracking.ts`, `graph.ts`, `undo.ts` | G05 REAL; G02 composed-UNGATED; feed/context 501 |
| 4 | `edge.ts`, `placement.ts` | G03 composed + W3 PASS → REAL |
| 5 | `message.ts`, `handoff.ts` | G04 residual 501 — **O1 lives here** |
| 6 | `project.ts`, `file.ts` | G06+G07 composed + W3 PASS → REAL |
| 7 | `inbox.ts`, `saved-view.ts`, `action.ts` | G08+G09 composed + W3 PASS → REAL |
| 8 | `event.ts`, `presence.ts` | `events.poll` ungated; subscribe WS skeleton; presence 501 |
| 9 | `session.ts`, `interaction-profile.ts`, `teammate.ts` | 4× `execution.*` registered-ungated; G12 501 — **O2 closes here** |

**Four seam rulings, all affirmed, issued before spawning because `registry.ts` throws at IMPORT on a
duplicate path** — a double registration is not a subtle red, it collapses every slot's suite at once.
**S1** `['entity','connections']` → group 4 (edge-shaped DTO, affirming the prior coordinator).
**S2** `['message','mark-read']` (`readMarks.upsert`) → group **7**, not 5: it is G08 read-state,
composed and W3-PASSED, and leaving it in group 5's 501 wasteland would strand a provable operation
behind an unprovable group. **S3** both `*.interactionProfile.setDefault` rows (A20 + teamMembers) →
group **9**, not 2 — **this overrides Slot D's existing packet**, since splitting a symmetric pair
across two modules is the drift risk module-ownership exists to prevent, and D is at zero lines so churn
cost is zero. **S4** `['file','upload']` binds **two** operations (`files.uploadInit` +
`files.uploadComplete`) behind one command path — the §3.1 cardinality trap; group 6 registers it once.

**Group 5 is blocked from being PROVEN, not from being WRITTEN.** Its grammar, argument binding,
help/completion projection, JSON shape and unit tests are contract-derived and provable today; only
integration and O1 wait on G04 composing. Same for the 501 halves of groups 8 and 9. The per-slot
integration-class column above goes into each worker packet so no worker quietly upgrades "grammar
green" into "operation works".

**Staging: four now, four as the first four report** — the account-wide limit killed this wave once, and
per the ledger it *counterfeits progress*. Both waves are staging and share capacity.

## 19. M-5 — priority correction: the brake was the bottleneck (2026-07-27)

**Trigger.** The user asked whether W1–W3 was working on edge cases. It was. The full-program
coordinator had set that priority and had spent two consecutive responses on migration numbering and
clobber analysis while the product did not work.

**Honest accounting at the moment of the challenge.** Three of the closure wave's four active slots were
SEC-1, on a system with **no deployed node, no users and no data**. Meanwhile **G10 and G11 were
unimplemented** and **five frozen groups were uncomposed**, so `messages.post`, every `handoffs.*`, every
`interactionProfiles.*`, `presence.get` and `entities.feed` all returned 501 — **you could not send a
message in tm8.** Only the `tracking.refresh` fix was a functional defect in a live operation.

**The structural error, stated so it is not repeated: "must be fixed before anything SHIPS" was read as
"must be fixed before anything COMPOSES."** Those are different gates and only the first was ever real.
That misreading made a brake protecting a nonexistent node into the critical path for three waves —
blocking tranche-v3 composition → W3's public gates → G3, and independently W4's O1 → G4.

**A secondary cost, worth naming.** The instrument/method findings of §15 were genuine and valuable, but
they became **self-propagating**: each finding spawned a second reader, a mutation test, and a harness.
Rigour that generates more rigour than product needs a priority check, not more rigour.

### 19.1 Rulings

1. **The composition brake is LIFTED, unconditionally.** SEC-1 gates nothing in W2/W3/W4. It becomes a
   documented **pre-ship** blocker.
2. **Tranche-v3 composition is the closure wave's top priority:** G04, G12, G13, G14. Highest-value
   action available — it turns ~25 dead operations live, and **composing G04 replaces the
   `messages.post` 501 stub with the real frozen handler, unblocking W4's O1.**
3. **SEC-1 shrinks to a minimal batch and stops.** **KEEP `032`** (per-site Stage 1b — it carries the
   **resource-binding half that `033` cannot**, since `ledger_replay` cannot know the addressed resource,
   so it is what actually turns W3's executed same-principal/different-Space red green; plus
   **strip-at-source** `to_jsonb(invite) - 'code'` at all three invite sites, a one-line permanent
   defence against the bearer-credential invite-code leak). **KEEP `033`** (three lines in one shared
   function closing 108 sites — the best value-per-effort in the security program). Proof standard: prove
   the pin **fires once**, with the positive half so it cannot pass by refusing everyone. **Not a
   108-site verification program.**
4. **STOPPED:** the §17.6 concurrent race harness (stood down — the clearest single instance of the
   misprioritisation; the independence gap is **recorded as pre-ship, not resolved**), migration `034`
   (the `027` tier fix — deferred; G12 composes with the tier defect present and documented), and
   Stage 2 (not opened).
5. **Work order:** tranche-v3 composition → G10 → G11 → then verification of the newly composed groups
   and recorded G3 readiness. `032`+`033`, `G02-FIX` and `NULL-PRINCIPAL` continue as **non-blocking**
   parallel tracks.
6. **§18.1's mandatory anti-clobber condition on `034` is WITHDRAWN** — deferring `034` removes the
   later-migration-clobbers-the-pin question entirely. The re-derivation stands as recorded and travels
   to the pre-ship packet so the eventual author inherits it: `033` defines **exactly one** function
   (`internal.ledger_replay` at `:290`, confirming its own header rather than quoting it); the `034`
   candidate defines **33**, none of them `ledger_replay` or `require_replay_principal`; and the closure
   coordinator **also checked the axis the ruling failed to name** — `031` redefines **eight** functions
   (`:172`, `:208`, `:235`, `:347`, `:416`, `:499`, `:600`, `:727`) and that intersection is **also
   empty**. A SAFE claim from a **first reader only**; the named-second-reader requirement travels with it.

### 19.2 Pre-ship blocker list (carried out of W0–W5)

Nothing here gates a wave. All of it gates **shipping**.

- **SEC-1 remainder.** Stage 1b sites beyond `032`, Stage 2, and the `23514` oracle removal
  (`ledger_replay` interpolates the cmid **and the true owner's operation label** into message text
  reaching the wire verbatim — `016:34-37` → `db/errors.ts:82` → `http/errors.ts:89` — upgrading guessing
  to guided search).
- **The `027` replay-tier fix — NO RESERVED MIGRATION NUMBER.** It was briefly labelled `034`; **`034` is
  now G02-FIX**, so the tier fix takes the next free number at pre-ship time. *Do not carry a reserved
  number across a deferral* — two different things called `034` is exactly the collision that made the
  `032`/`033` pin renumbering load-bearing (§18.1/C1). Carries the enumeration above and **this requirement,
  which is the sharpest finding of the session and would otherwise be discovered too late:** `033`'s pin
  raises **inside** `internal.ledger_replay`, **before it returns**, so for a cross-principal caller
  `internal.w2g12_authorize_replay` (`034:167`) is **never reached**. A tier matrix whose negative half is
  built from cross-principal cases therefore **goes green while measuring `033`'s pin and reporting on
  `027`'s tier — every case passes and nothing is tested**, with file-level evidence looking perfect.
  This is §17.7's lesson one layer out: **the first refusal is not even in the function under test.**
  Required construction: the negative half must exercise the tier where the pin does **not** fire —
  **same-principal, differing-tier** cases, concretely *a Space member who is neither owner/admin nor the
  Teammate that proposed the profile, replaying their own cmid* — which is exactly the case `034` exists
  for and precisely the one a cross-principal framing skips. Plus the positive half, so the guard cannot
  pass by refusing everyone.
- **§17.6 gate-independence gap.** No harness can currently verify concurrency ordering, so `033`'s
  race-correctness property rests on its author's own test. Scoped to the **108** unpinned sites, per the
  `031`-already-pins-12-in-6-pairs correction.
- **The `tsconfig` `include` widening** (§11.2), still deliberately deferred to its own scoped task.
- **G0.2 amendment batch** (§12), still open and unstarted.
- **W6/Phase-2:** a node-advertised capability set — the only fix for cold-cache agent planning
  (§10); and `019:1136 w2_prepare_handoff`, safe only by a **coupling invariant, not a check** (§14A.2).

### 19.3 Ruling — tranche-v3 is a DELIBERATE severity change, accepted at full strength

**§19.1 ruling 2 was incomplete and the closure coordinator flagged it.** It ordered G04 composed without
saying that G04 was named *separately* in the brake for a reason that survives the lift.

The coupling, exact: `message_batch_id` exists from `015`; **only G04's `019` populates it** from the
cmid; and the composed **read** path is already wired at `facade/entity-read.ts:583`, which projects
`messageBatchId`. So the moment G04 composes, **cmids become readable through read surfaces that already
hold a public PASS**. The program's own adopted phrasing describes precisely this action: *"reachable; not
self-serving today only because all four cmid-publishing read surfaces sit behind uncomposed groups —
G04, G10 and G13. Composing any one of them makes it self-serving."* And *"the gun is loaded and pointed
— G04 pulls the trigger"* is a sentence this program wrote about the exact step now being taken.

**Composition proceeds** — on an undeployed, single-loopback-identity node there is no second principal to
serve, and `032`+`033` land in parallel. But the risk is **accepted with its severity stated at full
strength, not accepted by quietly downgrading it**, and two consequences are **binding, not aspirational**:

1. **`032`+`033` are promoted from a documented pre-ship footnote to A NAMED PRE-SHIP GATE WITH A STATED
   REASON:** they close a defect that tranche-v3 *deliberately makes self-serving*. Still **not** a compose
   gate. But **if anything ever ships with tranche-v3 composed and `032`+`033` absent, that is a live
   privilege-escalation path, not a backlog item.**
2. **The forbidden phrasing TIGHTENS.** As of tranche-v3 landing, nobody may write that cmids are
   unharvestable **or** that the replay defect is not self-serving. The tense that was load-bearing has
   **turned over**: the future case became the present one, by deliberate act. A later reader must find
   this recorded, not discover it.

**G10 corrected to PARTIAL** — see the callout at the head of §17.3. Sixth worker correction of a
coordinator-level figure; **the record still contains no instance of a coordinator figure surviving a
worker challenge.** Composition was preceded by the coordinator verifying the G04/G12/G13/G14 freeze
claims itself rather than composing on a status field — composing on an in_progress/frozen disagreement is
exactly how behavioural drift enters a tranche unnoticed.

**The §17.6 harness was stood down before it created a single scratch database** and replaced by a
~20-minute **read-only adversarial sufficiency review** of the `033` author's existing suite — the
cheapest honest form of independence for the pin, in place of a two-hour build.

**Constraint on reading its result, recorded because it points the program's own rule at the program's own
good news.** The stood-down session found that the `033` suite *already* does two-connection concurrency,
`pg_locks` parking, distinct non-null principals read back from storage, and paired positive controls —
which would **shrink** the recorded §17.6 gap. That is a **retraction in the reassuring direction**, which
per §15.5 deserves the same scrutiny as the original alarm and will attract far less. **§17.6 and §19.2
may not be shrunk on that read alone; the sufficiency review is the scrutiny and reports first.** Its
substantive mechanism correction stands: the relevant mechanism is **`016:17`'s advisory xact lock, NOT
`012`'s INSERT-ON-CONFLICT reservation, which `016` superseded**.

**Noted as a first for this program:** that session flagged **unprompted** that copying the author's
mechanism would make agreement *structural and worthless*, and chose a different call site and observation
channel **before being told to** — §15.5 applied by a worker to its own not-yet-written evidence,
prospectively rather than as a retraction.

**On the convergence itself.** The closure coordinator had independently stood G down and descoped A before
M-5 arrived, and correctly labelled that **replication, not corroboration**: same evidence, two readers,
able to disagree only by misreading — it rules out a slip, not a shared blind spot. **The genuinely
independent mechanism was the user's**, asking whether the work *mattered* rather than whether it was
*right*. Neither coordinator had that vantage, and no amount of rigour inside the wave would have supplied
it. **Recorded as the highest-value correction in the program to date.**

### 19.4 NULL principal IS reachable — an UNAUTHENTICATED LEDGER WRITE (executed, 2026-07-27)

**§14A.1 required this answered before `033` was authored. The answer required action.**

**The defect.** `public.reset_session_wake_budget_for_member_reply`
(`db/migrations/015_w1_foundations.sql:1497`, `execute` granted to `tm8_app` at `015:2178`). Its **first**
branch — reply message not found, or author entity not `kind='member'` — builds `{reset:false}` and
`return internal.ledger_record(…, 'messages.delivery.memberReset', result)`. **`internal.require_space_member`
is on the line AFTER that return and is never reached.** An identity-less `tm8_app` caller passing any
unknown uuid takes the ungated branch, records, and **commits**.

**Measured, not inferred:** unbound caller, `internal.identity_id()` read back inside the transaction and
asserted NULL as a control, called with `00000000-0000-4000-8000-0000000000ff` → returns `{reset:false}`,
transaction **COMMITS**, `command_ledger` holds one row with **`identity_id` NULL**. A second identical
unbound call **REPLAYS** it. **Both halves of §14A.1's question are YES: recordable AND replayable.**
Artifact `packages/server/test/db/w2-null-principal-ledger.pg.test.ts`, 22/22,
`RUN v2.1.9 …/packages/server`, chain from `migrationFiles()` with `033` asserted absent.

Baseline of all five cells on the landed chain: `(non-null, same)` replays; `(non-null, different
non-null)` replays — the SEC-1 defect; `(non-null, caller NULL)` replays with no authorization reached;
`(NULL, non-null)` replays; `(NULL, NULL)` replays.

**RULING 1 — a second confirmed defect, and a class not previously recorded: a pre-authorization return on
a WRITE, not a disclosure.** Not legitimate: the early return exists for no-op idempotence, and
`require_space_member` on the very next line proves the author intended it to cover the function.

**The consequence neither the wave nor the worker named, added by the full-program coordinator:** since
`(stored NULL, caller non-null)` **replays**, an unauthenticated caller can **PRE-REGISTER a cmid** with a
`{reset:false}` body, and a later **legitimate** caller using that cmid gets the attacker's no-op replayed
instead of performing a real reset. **This is cmid POISONING via an unauthenticated write — a functional
attack on delivery budget resets, not audit-log pollution.**

**RULING 2 — PRE-SHIP, not a wave gate.** This is exactly the shape that produced the M-5 error: a real
finding, correctly characterised, arriving with an implicit invitation to halt. It gates neither
composition, G3, nor the minimal batch. **To VERIFY rather than assume, because it bounds severity:** the
measurement is DB-layer with an unbound caller, whereas §6's G0.1 record froze the delivery DB boundary as
**exactly** `reserve_`/`claim_`/`settle_session_message_delivery` — and this RPC is **not** among them. If
that holds, no legitimate unbound caller exists **by design**. **State the reachability class explicitly:**
SEC-1 was upgraded because W3 *executed* it publicly; a DB-layer unbound-caller result is a **weaker**
reachability claim. Weaker is not zero — it is a different label.

**RULING 3 — `033` writes fail-closed EXPLICITLY for the NULL cases.** Now demonstrably load-bearing
rather than stylistic: asserted in SQL, `null is distinct from null` is **FALSE** and `null = null` is
**NULL**, so a compact `if stored is distinct from current then raise` moves every cell **except**
`(stored NULL, caller NULL)` — **a state now proven reachable**, where the pin would be **silently inert**.

**RULING 4 — the "cost" IS the fix.** A `033` guard refusing NULL-vs-NULL turns that RPC's not-found branch
into `23514` for unbound callers. **An unauthenticated caller losing the ability to write a committed audit
row is the desired outcome, not collateral damage.** The only genuine risk is a *legitimate* system
principal calling unbound, bounded by ruling 2's allowlist check. Blast radius accepted as
**bounded-by-search, not proven-empty**, stated as such. No runtime call-site audit of the delivery worker
now — that is pre-ship.

**RULING 5 — 92 adopted, 108 retired.** See the corrected §18.1/C2 callout.

**Endorsed, and a NEW NAMED CLASS: A RED THAT IS DESTROYED BY THE FIX IT JUSTIFIES MUST BE ARCHIVED BEFORE
THE FIX LANDS.** `w2-sec1b-…-principal-pin.pg.test.ts:62` flips `CANDIDATE_IS_LANDED` the moment a `033_`
file appears, making `SEC1B_CANDIDATE=none` inert — so **after landing, that suite can never re-capture its
own red.** Landing the pin would have destroyed the only evidence it was ever needed. Capture-and-archive
tasked before the batch lands. Every wave should check for this shape.

**Adopted as method: `pg_catalog` over file grep for any completeness claim about DB behaviour.** `012:83`
puts a reservation INSERT inside `internal.ledger_replay`; `016:17` **redefines it without one**. So the
files say **two** write sites and the landed chain has **one** — `internal.ledger_record`, sole live writer,
established from the live catalog of the applied database and **mutation-tested inside the scratch DB**
(add a writer → sweep sees it → drop → sweep clean). Reading files gave the wrong answer. Same
delta-versus-whole-file trap as §17.7, in a new place.

**Corroboration that the minimal batch must keep `032`:** `033` does **not** close `create_invite`
(`007:573/583/584/585`, never redefined by any later migration, not one of `031`'s six, stored result
carries the live code `redeem_invite` consumes) — a second mechanism reaching the conclusion §19.1 ruling 3
had made for the resource-binding reason.

**DEFERRED — the M-5 discipline applied to a finding the coordinator wanted to chase.** The *"of 97 live
functions calling `ledger_record`, 94 pass an identity-requiring helper first"* claim is **single-reader**,
and its author labelled the limit: textual position of helper-call versus `ledger_record`-call is exactly
the analysis that misses a gate reached via a branch or nested in another helper — **which is how its own
two false positives arose** (`w2_complete_file_upload`, `w2_abort_file_upload`, correctly **disproved** and
correctly reported *as disproofs*). §14A.2 requires a named second reader for a SAFE claim and *"94 are
gated"* is the reassuring half. **Deferred to pre-ship anyway. Record `1` as a VERIFIED LOWER BOUND, not a
proven exact count, and record the safe half as unverified single-reader.** Better a labelled hole than a
session spent closing it on an undeployed system.

**Also pre-ship — `claim_text` blank-claim normalisation.** `internal.claim_text` (`001:151`) uses `btrim`
with **no second argument**, so it strips **spaces only**: a tab- or newline-only `tm8.identity_id` claim is
**not** normalised to NULL, and `public.create_space` **succeeds** for identity `'\t'`, minting a Space with
`created_by_identity '\t'` and a member row, because `require_identity()` tests only for NULL and that path
has no `public.accounts` existence check. It yields **no NULL principal**, so it does not change ruling 1.
**Preserve the exact distinction, which had been running as one claim:** `008:14`'s *"an unset claim fails
closed everywhere"* is **TRUE**; *"a blank-looking claim fails closed"* is **FALSE**. Found by a worker that
asserted the reassuring version first, watched its own suite go **RED**, and corrected itself.

### 19.5 Arbitration — `savedViews.update` version guard: THE PROJECTION IS WRONG, NOT THE CONTRACT

W4 escalated a suspected contract defect: `SavedViewInputSchema` (`schemas.ts:961`) is `.strict()` with no
`expectedVersion`, while the CLI projection (`packages/cli/src/discovery/operations.ts:746-753`) declares
`ver: 'expectedVersion'`, requires `--expect-version <n>`, and summarises the row as *"Redefine a saved view
under a version guard."*

**Ruled from source across four layers: the guard is FICTIONAL AT EVERY LAYER — no amendment, no G0.2, no
dossier change, and the fix is W4's.**

1. `schemas.ts:961` — input schema `.strict()`, no `expectedVersion`.
2. **`schemas.ts:1705` `SavedViewSchema`, the READ DTO — NO `version` field at all.** *Decisive, and it
   inverts the escalation's framing:* even if the input field were added, **no client could ever populate
   it**, because the read projection never discloses a version to guard against. Same
   **unreachable-by-construction** class as §12 item 1's `messages.delivery.get` cursor.
3. `db/migrations/024:77 public.update_saved_view` takes exactly `(p_view_id, p_name, p_share_mode,
   p_query, p_graph_layout, p_actor_id, p_client_mutation_id)` — **no expected-version parameter**; its
   validation is name/share_mode/query/graph_layout only. No storage-layer guard exists to bind to.
4. `W0-AMENDMENT-DOSSIER.md` — **zero hits for `savedViews`.** No adopted A-row requires a guard here.

Contrast where the guard is real: dossier `:82` requires `expectedVersion` on `messages.edit` and
`messages.delete`, and 11 schemas carry the field. The pattern exists; savedViews is not in it — the
projection author pattern-matched a neighbouring guarded row.

**W4's fix:** remove `ver:`, drop `--expect-version` from the synopsis, and **correct the summary too** —
"under a version guard" is itself the false claim, and fixing the flag while leaving the sentence would
leave a dishonest surface in the help text. **The escalation was still right:** a self-contradicting
projection unfixable under its own ownership boundary, refusing to let a worker invent a field, routed
rather than guessed.

**Class sweep authorized, BOTH DIRECTIONS.** Direction A (declared `ver:`, no schema field) fails **loud**
— `.strict()` rejects. **Direction B is worse and the escalation's framing would miss it:** a schema with a
**required** `expectedVersion` and no `ver:` in the projection means the CLI never asks, never sends, and
**every call 400s**, with help text giving no clue why.

**Coordinator cross-check, with its limit stated:** 12 projection rows declare `ver:` against **11** schema
sites with a required `expectedVersion` — consistent with exactly one unbacked row. **Not banked:** a count
cannot say *which*, and would read identically if two rows shared one schema while a different row were
missing — the **compensating-pair** shape that made `73 + 25 = 98` look like a cross-check. A hint that the
answer is small; the per-row join runs anyway.

**W4's self-correction, recorded for its direction:** *"I was reassured by my own disproof and stopped
looking; the worker holding the uncomfortable position kept going."* §15.5's comfortable-results rule
applied to **a coordinator's ruling** rather than a worker's finding — a place this program had not yet
pointed it. Two further points it got right: citing `spaces.list` as a witness for a **different service**
was two mechanisms aimed at the wrong question wearing the costume of mechanism diversity; and
**silently-ignored is worse than rejected** for an agent, because it pages forever and no error ever fires.

## 20. TRANCHE-v3 COMPOSED — the surface is 97/100 (2026-07-27)

Measured from a real `bootstrap()` listener, not predicted: `/health` `{operations:100, implemented:97}`;
an **unmodified independent detector** prints `mounted=97 residual=1 [presence.get]`; 157/157 pass; all
three transport seams byte-identical; **chain unrotated**. W4 notified with the measured read. **O1's
blocker is gone** — `messages.post` is no longer a 501 stub.

`presence.get` is the sole residual, and it belongs to G10 — see §20.2.

**Elapsed: roughly ninety minutes after the composition brake was lifted.** That figure is the measure of
what the brake was costing, and it belongs next to §19's priority correction rather than buried in a status
line.

**G02-FIX is complete** with a real production multi-Space red, landing as **migration `034`**, sequenced
behind `032`+`033` because `migrate.mjs` applies lexically and backfilling would be an out-of-order insert.
**`034` therefore means G02-FIX, not the deferred tier fix** — see the corrected §19.2 entry.

`032` assembling; `033` authored; **the pre-`033` red is ARCHIVED** (6/6 against an independent prediction,
bracketed by a 15/15 with-candidate run) per §19.4's archive-the-red-before-the-fix rule.

### 20.1 Arbitration — client→server WS control protocol: RULED (A), add it to `@tm8/contract`

**The hole.** The contract defines the server→client `WorkspaceEvent` but **no client→server message** for
subscribe / unsubscribe / presence / resume-from-seq. Three of G10's four adopted requirements — semantic
WS delivery, reconnect-replay reconciliation, presence — all depend on it.

**Not an oversight: a documented refusal** at `ws-server.ts:47-55`. `SubscriptionRegistry` *has* the
methods; the author declined to call them from the wire rather than put an off-contract protocol on the
socket, leaving `onClientMessage` as *"the honest hole instead."* **That refusal was correct** for someone
without authority to change the contract and is recorded as such, not as a gap they left. The G10 worker
reached the same judgement **independently, before reading that comment** — different reader, different
route, same conclusion: genuine corroboration.

**RULED (A).** Option (C) — encoding subscribe in the upgrade query string (`/v2/ws?spaces=a,b&since=N`) —
is **REJECTED**, and the decisive reason is **functional insufficiency, not inelegance**: a query string is
evaluated **once at upgrade**, so it cannot express subscribe-to-an-additional-Space, unsubscribe, or
presence-toggle without **tearing down and rebuilding the socket**. The workspace switches Spaces; under
(C) every switch drops the connection and re-replays. (C) can serve resume-from-seq and initial subscribe
and **cannot serve two of the three adopted requirements** — so choosing it would not be picking a cheaper
surface, it would be **silently narrowing the requirement, with the narrowing living in the wire shape
where nobody would find it stated.**

**The in-tree precedent does not transfer.** The PTY socket's `?sessionId=&offset=` is a **single-purpose,
single-subject** socket — one session, one cursor, no multiplexing, no membership changes. The workspace
socket is **multiplexed across Spaces with dynamic membership**. Citing it is the same shape as W4 citing
`spaces.list` as a witness for a different service (§19.5): a real precedent aimed at a different problem,
which reads as support and is not.

**Why (A) is rulable without a dossier amendment.** The dossier **adopted** semantic WS delivery, replay
reconciliation and presence, and those are **impossible** without a client→server channel. So the contract
is **incomplete relative to its own adopted requirements**; specifying the wire shape *completes* an
adopted requirement rather than adding a surface. That is materially different from inventing a capability.

**Four binding conditions.** (1) **Minimal and requirement-bound** — exactly subscribe, unsubscribe,
presence, resume-from-seq; every frame traces to an adopted requirement in writing; nothing speculative.
(2) **Verify, do not assert, that no amendment is needed** — quote the adopting dossier text, confirm **no
catalog row and no operation** is added. Expectation is that catalog digest `sha256:df96ff5a…` does **not**
rotate because it hashes `OPERATIONS` and schemas are separate — **but that is an expectation, not a
measurement, and §12 requires a measured impact analysis.** If a catalog row turns out to be needed,
**stop and return to arbitration**; that may need G0.2. (3) **Measure and announce the unbinding** — which
frozen seam hashes rotate, whether conformance manifest `062ec620…` changes, which W3 verdicts and W4
bindings come unbound; announce to W4 **before** landing, since its group 8 owns `event.ts`/`presence.ts`
and holds the WS subscribe skeleton. This is the **reverse** of the normal direction (W4 routes contract
needs *up*), so it needs an explicit heads-up rather than a discovery. (4) **(B) remains the landing
path** — tested exported seams behind the existing `onConnection`/`onClientMessage` hooks, so (A) is one
call and not a redesign.

### 20.2 A live authorize-everyone path in the WS layer — inert today, ARMED by landing the protocol

Measured: `SubscriptionAuthorizer.canSubscribe` has **zero call sites** anywhere in `packages/` or
`tools/`; `ws-server.ts` never accepts an authorizer; `main.ts:112` passes none; and `ws-server.ts:128`
therefore accepts **every** upgrade as `{ kind: 'auto-owner' }`. `AllowAllSubscriptionAuthorizer`'s own
docstring says it **MUST NOT ship past W2**.

**This is the SEC-1 class INVERTED, and it is to be stated that way.** SEC-1 was *"the defence already
existed, in exactly one file"* — a guard the codebase converged on four times and never generalised. Here
the defence exists and is called in **zero** files. Same root disease: **a guard whose existence was
mistaken for its enforcement. A written authorizer that nothing invokes is not a partial defence, it is a
comment.**

**Binding, not optional:** invoking the authorizer is **part of G10's build, not a follow-up**, and the
**negative half — a subscriber must not receive another Space's events — is written BEFORE the positive.**
It must ship *with* the protocol because **it is inert only because nothing subscribes, and landing the
wire is what arms it.** "Inert today" may not become the argument for sequencing it later — that is the
**tense error** M-5 already caught once.

### 20.3 NEW NAMED CLASS — a stale risk note is an instrument too

**§5's standing risk *"the current live event publisher uses in-memory sequence state"* names a SOLVED
problem and hid the live one. It misdirected three coordinators.**

Measured: the durable per-Space counter **is durable by construction** — a table row at `003:282` with
`internal.next_event_seq` doing insert-on-conflict-do-update **inside the mutating transaction**.
`InMemorySeqSource` is merely an **alias for `PresenceSeqSource`**, which is **correctly** ephemeral per
DEV-4, because a presence seq is channel-local and must never be a durable cursor.

**The real defect is bigger and the note concealed it: `WorkspaceEventPublisher.publishDurable` has NO
production caller, so no durable event ever reaches a socket.**

**The class:** a risk register that names a solved problem does not merely waste attention — **it absorbs
the attention the live defect needed, while looking like diligence.** §15's *verify the instrument* now
extends to the program's own risk notes, not only its test harnesses.

Also stale and assigned to G10 as server source: `main.ts:108-110` calls the in-memory source *"a SKELETON
stand-in … at W2 it is replaced by the per-space monotonic counter"*, which now **reads as an instruction
to do the wrong thing**. A comment that misdirects the next implementer is a defect.

## 21. Findings and rulings, 2026-07-27 (late)

### 21.1 TWO DOORS — the retrospective justification for the callee pin

**The strongest thing produced today, and it came out of trying to prove a site SAFE.**

The `032` author reported that `public.w2_post_message_batch` needs no binding: it is already guarded by a
hash comparison covering **both** principal and resource. The closure coordinator found the trace
convincing and was about to drop it — then routed it to a **named second reader** under §14A.2
**precisely because it was the reassuring item** in a report that otherwise contained two alarms.

**DISPROVED.** All four of the author's claims are **TRUE** as statements about that function: no bare
return; `identity_id()` genuinely the first hash input; the request canonicalization genuinely hashed;
fail-closed on an absent `_stableHash`. **The false thing was an UNSTATED PREMISE — "the hash guard is the
only way to reach this row."**

`public.post_message` (`007:1680`) **uses the same ledger operation label**, with a **bare return** at
`007:1695` and `require_space_member` only at `007:1697`. `internal.ledger_replay` keys on the cmid and
validates only the **label** — **it has no idea which function called it.** So a row written through the
hash-guarded `019` door is replayable through the unguarded `007` door, and the hash comparison is never
reached **because the attacker uses the other door.**

> **The guard protects a FUNCTION; the vulnerability is a property of the SITE, and the site has TWO
> DOORS.**

**This settles §14A.1 on stronger grounds than it was ruled.** That ruling chose the shared callee pin on
**blast radius** — three lines in one function versus 79 per-site edits — which was correct but was an
argument about **cost**. This makes it an argument about **correctness**: a per-site guard covers the site
it is written at; **a callee pin covers every door into the same ledger row.** Per-site guards are not
merely more expensive, they are **structurally incomplete against a shared-label ledger.**

Fourth landing of *authorization is a property of the whole path*, and its subtlest — here it is not even
the same path.

**Added to the second-reader rule: A SAFE CLAIM'S FAILURE MODE IS USUALLY AN UNSTATED PREMISE, NOT A FALSE
STATEMENT. The second reader's job is to find the sentence the author did not write.**

**Ruling:** `w2_post_message_batch` stays **OUT** (its hash covers both halves on its own path, and a
weaker guard beside a stronger one invites a later "duplicate" deletion). **`public.post_message 007:1680`
goes IN.** Reachability, scoped and not to be upgraded: **not** reachable through the composed HTTP
boundary (zero facade callers; `messages.post` routes to the guarded `019` function); **is** reachable by
anything executing SQL as `tm8_app` via `008:234`'s blanket grant; in-repo nested caller is clean
(`place_entity` passes NULL cmid at `018:342-343`, `018:381-382`).

### 21.2 `033` accepted — the pin, measured

Three **explicit** branches (stored-null OR caller-null OR mismatch), so `(NULL, NULL)` fails closed **by
name** rather than by `is distinct from` semantics. Truth table measured with the candidate applied:
`(NULL,NULL)` RAISE · `(NULL,bob)` RAISE · `(alice,NULL)` RAISE · `(alice,bob)` RAISE · `(alice,alice)`
**returns its stored result** — the positive half, so it cannot pass by refusing everyone. Leak scan across
every raised message: **zero** cmid occurrences, **zero** true-operation-label occurrences. Suite 15/15.
**Baseline attack reproduced end to end on the landed chain** — a row stored with `identity_id` NULL handed
verbatim to a stranger: §19.4's cmid poisoning, **executed rather than argued**.

**92 unpinned is settled — three mechanisms that could genuinely have disagreed:** INV-2's recorded LIVE
minus 6; a static last-definition-wins parse; and an independent `pg_catalog` enumeration on an applied
001–031 chain finding all 98 referencing functions `SECURITY DEFINER` with exactly 6 pinned.

**New rule: DO NOT ROTATE A HASH TO SIGNAL WORK.** The reviser kept the file byte-identical rather than
manufacturing a cosmetic edit that would rotate a hash already holding verification.

### 21.3 A STALE OR ASPIRATIONAL DOCUMENT IS AN INSTRUMENT TOO

Three W4 findings share one shape: **a design document describes a field or behaviour the frozen contract
never adopted, and the program describes the operation by the proposal rather than by the contract.**
`actions.list`'s `allowed`/`reasonCode`; `projects.link`'s `projectEntityId` (one occurrence, in
`CLI-GRAMMAR-REDESIGN.md:577`, **zero** in the contract); the grammar doc spelling guard-bearing
commands **without** their guard.

Same disease as the stale risk note of §20.3. **§15's "verify the instrument" extends to the SPECS WE
QUOTE, not only the harnesses we run. When a doc and the contract disagree, the contract is the authority
and the doc is a proposal until a gate says otherwise.**

**Countermeasure, cheap and mandatory: any packet asserting an operation returns a field must cite the
CONTRACT line, not the design doc.** Three coordinators propagated proposal-language as contract-language —
**and the canonical instance is the M-3 ruling text itself**, written by the full-program coordinator and
inherited by W4 in a packet from it. See the callout in §10.

### 21.4 The guard is spelled FIVE ways — a count blind in the dangerous direction

`expectedVersion`, `expectedRevision`, `expectedRecordVersion`, `expectedArtifactVersion`,
`expectedSettingsRevision`. **A grep for `expectedVersion` sees 11 of SEVENTEEN guard-bearing DTOs, and the
six it cannot see are exactly where the silent Direction-B defects live** — because a row spelling the
guard differently is precisely a row nobody had matched against a projection. **7 more defects, not 0.**
The full-program coordinator's "12 vs 11 is a hint" was not merely approximate; it was **systematically
blind to the rows most likely to be broken.**

> **GREP FINDS THE NAME YOU ALREADY THOUGHT OF; RUNTIME ZOD INTROSPECTION FINDS THE SHAPE.**

Adopted program-wide: any completeness claim over schema structure goes through **introspection, never a
name grep** — the same pattern as §19.4's `pg_catalog`-over-file-grep, which makes it a pattern rather than
a one-off.

**Ruling on the five escalated rows: THE FROZEN SCHEMA IS THE AUTHORITY FOR WHETHER A GUARD EXISTS; THE
FLAG SPELLING IS W4's OWN SURFACE.** The schema names the field **and names it required**, so the
capability is already adopted and "omit it" was never an option — omitting it means every call 400s and the
operation is dead. Only the CLI flag name was unspecified, and that is not contract territory. **Mechanical
derivation adopted:** kebab-case the schema field, dropping nothing (`expectedRecordVersion` →
`--expect-record-version`). Where an authority names a spelling it wins; the derivation is the default.
All four rows are **restoration of a frozen requirement, not new surface** — no G0.2, no amendment.

**W4's EXACT-SET quarantine is adopted program-wide.** It **goes red in BOTH directions**: a new
Direction-B row fails the suite, *and* closing one without delisting it also fails. **The first genuine
structural remedy for "an assertion whose subject gets fixed"** — a skip decays silently, this cannot, and
unlike a comment it does not depend on a future reader reading it.

### 21.5 `messages.list` — the mechanism was WRONG, and the wrong fix would have looked right

The column-mix-up story (entity vs message `created_at`) **was relayed program-wide by the full-program
coordinator and is refuted.** Both inserts are in **one transaction** (`019:452-458`) and both columns
default to `now()` = `transaction_timestamp()`, identical for every statement in it — so
`e.created_at` **equals** `msg.created_at`, the tuple compare is false for the cursor's own row, and the
mix-up **cannot** be the live cause. Real, but **latent**.

**Actual cause: MILLISECOND TRUNCATION.** `timestamptz` holds microseconds; node-pg parses to a JS `Date`
holding milliseconds; `toISOString` emits milliseconds. The cursor is **strictly less than** stored, so the
keyset **re-admits its own row** — ~999 times in 1000. Measured: `06:34:13.421911` → `.421Z`.

> **A CORRECT-LOOKING FIX FOR A WRONG MECHANISM IS MORE DANGEROUS THAN NO FIX.** Carrying
> `msg.created_at` through `ENTITY_COLUMNS` would have produced a reviewable, obviously-correct-looking
> column diff **and left the bug live**, because truncation is downstream of which column is read. A
> plausible fix, a clean diff, a still-red gate — and it consumes the finding's credibility, so the gate's
> next red looks like a regression.

**Diagnostic adopted: AN UNEXPLAINED DETAIL INSIDE A CONFIRMED FINDING IS WHERE A WRONG MECHANISM HIDES.**
The gate read identical reproduction across two databases with two id sets as *corroboration* when it was
evidence **against** any id-dependent mechanism — i.e. against the one being proposed.

**Generalized: any cursor round-tripping a `timestamptz` through a JS `Date` has this.** Enumeration ordered
across G02, G03, G05, G08, G04 `handoffs.list`, G13. **The worse variant is named:** truncation re-admits so
it **loops loudly**; anything rounding a cursor **UP** would **SKIP and silently lose rows with no error.**
Both halves — **exactly-once AND terminates** — now asserted at every site. An exact-microsecond edge cursor
was **already** a named G03 requirement in the §4 acceptance matrix: someone knew this class once and it
never generalised, the same shape as the replay guard invented four times.

**Third mandatory cursor direction, program-wide:** §7.6's two directions do **not** catch this — the cursor
was accepted, its fingerprint matched correctly, and it resumed at the wrong row. **Fingerprint correctness
and keyset correctness are different properties.** Every cursor-exposing group must now prove that
**following `nextCursor` to exhaustion returns each item exactly once and terminates.**

Fixed and independently verified 7/7, bound to `handlers/messages.ts` `f2b45fb393e983c9`.

### 21.6 G0.2 CANDIDATE 3 — `savedViews.list` is an unpageable list

Measured against a real Server with a positive control run **first**: 3 saved views stored, `--limit 1`
returned **3**, response is a **bare array with no `nextCursor`**. Server side
`services/w2/saved-views-actions.ts:79-105` reads only `spaceId`. **Contract side verified before
adjudicating:** no `savedViews.list` entry in `INPUT_SCHEMAS`, no `SavedViewQuery` schema, no `pageOf`
wrapper. **The contract genuinely specifies an unpaginated list, so the server CONFORMS** — and the wave
correctly could not file it against itself.

> **Item 1 is a PROMISE WITH NO MECHANISM; this is a MECHANISM WITH NO PROMISE.** Same dishonest-surface
> family, opposite sides.

**AUTHORIZED before G0.2 closes: inventory EVERY v1 list-returning operation for the pair** — does it accept
paging inputs, does it return a `nextCursor` — **and state the law once**, rather than patching two
operations. Same discipline §12 item 2 required for the viewer-relative law. Read-only amendment prep;
dossier text routes to the full-program coordinator.

### 21.7 Two new instrument rules, both from a gate catching itself

**VOID-RUN RULE.** A gate ran a verification against a file the implementer was **mid-edit** and got a red
with the identical symptom — one step from filing *"the fix does not work"* against **correct code**, which
would have sent an implementer to re-fix something already right. The only tell was an anomalous transform
time, **403ms jumping to 4.38s**. Settled-file run: 7/7. **Adopted: when verifying a fix in flight, hash the
file under test immediately BEFORE and AFTER the run, and treat any mismatch as a VOID RUN rather than a
result.** The gate named its own irony: it had insisted on seam-hash binding for the *composition* and not
applied it to the single file it was actively verifying.

**ASSERT THE MECHANISM, NOT ONLY THE SYMPTOM.** The `messages.list` test now reads the cursor back off the
wire and requires **six fractional digits matching the stored column verbatim** — catching a reintroduced
`Date` round-trip **at the point of truncation** rather than waiting for it to resurface as a paging symptom
in a thread long enough to page.

### 21.8 Digest constructions — corrected, measured, and cwd-labelled

A worker reported `8c5227dfe17923c2` as not reproducing, derived `619a826887b4abf7` across six
constructions, and **correctly refused to assert a number it could not reproduce**. The canonical recipe
does reproduce. The coordinator's first correction then **misattributed a construction** — and a worker
caught that too. **Measured, same 28 files:**

```
canonical  (cd db/migrations && shasum -a 256 *.sql | shasum -a 256)   8c5227dfe17923c2
canonical recipe run from repo root                                    859dc6ccc1709a91
canonical recipe run from packages/server                              dd7d49b0705127aa
content-only (cat *.sql | shasum -a 256)  — cwd-INDEPENDENT            619a826887b4abf7
per-file hashes with FILENAMES STRIPPED                                16274743349461eb
```

The worker's `619a8268` was internally consistent and correct all along; **nothing was ever wrong with the
tree.** §15.5a recurring in a new place four hours after adoption — **and produced by a coordinator while
correcting someone else about §15.5a**, which is the most honest available demonstration that knowing a trap
is not protection against it.

### 21.9 Maestro task status — a tool limitation, settled, both waves stood down

`maestro task report complete` records a summary and marks the reporting session's contribution complete,
**but does not flip the task's aggregate Status.** Tested from the session that **owns** the task at spawn:
command exits 0, reports success, summary attaches, `maestro task get` still reads `in_progress` — with
**two** session statuses both `completed`. **So it is not an ownership property and not a quorum: the
aggregate does not derive from session status at all.**

43 W0/W1/W2/W3/W4 tasks were closed with full evidence summaries; every summary is attached and durable;
the project count did not move. **The summaries are the durable artifact and no further capacity is spent
on the status field.**

### 21.10 Exit code 8 has two different causes

`run.ts`'s *"not implemented in this CLI build"* versus the Server's honest **501** — **same exit code,
different fact, distinguishable only by stderr text.** Before the CLI registry was wired, an O1 measurement
through the built binary would have measured the **registry gap** and read as the **server**. Group 5 caught
this itself and labelled its mode. **Every O1 measurement must state which of the two it observed.**

## 22. The failed landing — three rules the program did not have (2026-07-27)

**Attempted, failed, reverted, tree restored byte-identical and re-verified green at 2/2, in minutes.**
`032`/`033`/`034` were copied in, the chain measured at 31 files / `5ccfd55dceb1e1c6`, and the full-chain
gate run **BEFORE any announcement** — which is the only reason this cost minutes instead of poisoning
every downstream verdict.

```
apply 032 ... ok
apply 033_w2_sec1b_ledger_replay_principal_pin.sql ... FAILED
ERROR:  permission denied for table applied_migrations
db/migrate.mjs: migration 033 failed — the transaction was rolled back, nothing was applied
```

**Root cause, one line.** `033` is the **only** migration in the repository with `set role
tm8_graph_owner` and **no matching `reset role`**. Balanced baseline measured across the chain: `031`
`:152/:865`, `032` `:132/:638`, `034` `:105/:166`, `019` `:10/:1359`; `033` `:282` with no reset anywhere.
So when the runner finishes the body and tries to record into `public.applied_migrations` — **the ledger
table `migrate.mjs` itself creates at `:142` and inserts at `:238`** — it is still `tm8_graph_owner`,
lacks permission, and the whole transaction rolls back.

**Corroborated, not replicated.** W4 reached the same mechanism **without being able to read the file**:
two workers archived the stderr verbatim before it became unreproducible, then inferred it from the `031`
contrast alone. Its worker **refused to reconstruct a file it could not read** and labelled the result a
strong hypothesis rather than a verified root cause — **which is what made the corroboration meaningful; a
reconstructed file would have produced a confident wrong trace.**

### 22.1 VERIFYING THE ARTIFACT IS NOT VERIFYING THE ARTIFACT'S DELIVERY

`033`'s own suite passed **15/15** and **structurally could not have caught this**, because it applies the
candidate via `database.query(sql)` on an already-privileged pool connection, whereas the real chain
applies via `psql` as `tm8_graph_owner` — so the test path **never reaches the runner's post-apply
bookkeeping**.

> **A migration verified only by direct application is not verified for landing.** Every candidate must be
> proven through **the same instrument that will apply it** — `db/migrate.mjs` and the migration-order
> gate — before the handoff is accepted. Applied retroactively to `032` and `034` even though both applied
> cleanly, because *"it worked"* is not *"it was proven through the shipping path."*

**§15's rule pointed one step further out: we had been verifying instruments and results; THE APPLIER IS A
THIRD THING AND NOBODY WAS TESTING IT.**

### 22.2 It was PREDICTED IN WRITING, filed as minor, and not actioned

The independent sufficiency review of `033`'s own suite listed as gap (c), verbatim: *"the candidate is
applied at `:190` via `database.query(sql)` on a pool connection, whereas the real chain is applied via
`psql` as `tm8_graph_owner` (`w1-pg.ts:80-84`). The migration self-elevates with `set role`, so it works —
but **the candidate is NOT APPLIED THE WAY THE CANDIDATE WILL SHIP**."*

**A new failure mode, distinct from every one recorded so far: not a false claim believed, but a TRUE claim
correctly filed and then not converted into an action.** Every existing countermeasure targets claims that
are *wrong*; this one was right, precisely stated, and read.

**The mechanism is the triage order.** Gap (c) sat in a list where gaps 1 and 5 were the alarming ones —
the same shape as the G14 "narrowest case" error but **inverted**: that one propagated because it was
*reassuring*, this one was dropped because it looked *low-severity*. **And delivery defects always look
low-severity, because they say nothing about behaviour — they are pure logistics right up until they roll
back the whole transaction.**

> **Countermeasure: a gap describing a difference between HOW A THING IS TESTED AND HOW IT WILL SHIP is
> never a minor note. Route it to an action or explicitly rule it accepted with a reason. Filing it is not
> a disposition.**

**The program had already hit this exact defect once.** W1.B2's official-runner repair exists because `015`
attempted ACL cleanup while still under `SET ROLE tm8_graph_owner`, the mixed-owner statement failed, and
`015` rolled back. **Same defect, same table, same permission shape, one wave later — and found the same
way both times, by the runner rather than by any suite.**

**Therefore a rule is not sufficient, because a rule is exactly what W1.B2 should have left behind and did
not. REQUIRED: a static check over `db/migrations` that fails when any file's `set role` count does not
match its `reset role` count** — one line of grep, with a known-good baseline today and a known-bad case in
the reverted `033` to mutation-test against (RED on `033`-as-it-was, GREEN on `033`-fixed), wired into the
same gate as the migration-order check. **This program's own evidence is that rules decay and detectors do
not** — the same shape as the replay guard converged on four times, and the exact-microsecond edge cursor
named in the §4 matrix, both never generalised.

**The sufficiency review paid for itself.** It exists only because §19.1 stood the concurrent harness down
and redirected that session to a ~20-minute read-only adversarial review instead of a two-hour build. **The
cheap independent read found a real landing defect the candidate's own suite structurally could not catch.**
Recorded as an argument for that trade — and sharpened: **the cheap instrument worked; the expensive part
was the disposition.**

### 22.3 THE EXCLUSIVE LANDING WINDOW — a landing is globally disruptive

The author-outside-the-repo protocol (§15.5b) keeps the directory quiet during **authoring** and does
nothing for the **landing itself**. Two independent failures in one attempt, both caused by landing into a
live workspace:

1. **Measured by W4:** while the 31-file chain was on disk, **no scratch database could be created**, so
   every integration file in `packages/cli` failed its `beforeAll` — **9 files failed, 159 tests skipped**.
   Causation properly tested: the foreign failing file run alone, with none of the worker's modules loaded,
   failed identically.
2. **Captured during the revert:** `psql: error: …032_….sql: No such file or directory` — **a file
   disappearing between `migrate.mjs` listing the directory and `psql` opening it.** Landing and un-landing
   are **not atomic** against a running suite.

**Adopted, both waves:** announce a **landing window** before copying anything in; both waves **quiesce
DB-backed suites** for it (in-flight runs finish, nothing new starts); copy in, run the full-chain gate,
then announce the result; **if the gate fails, revert inside the same window** so no suite observes the
half-state; **any suite failure observed during an announced window is presumed window-caused until re-run
afterwards and is never filed as a defect.**

### 22.4 AN ANNOUNCEMENT IS EVIDENCE, NOT AUTHORITY — THE TREE IS THE AUTHORITY

W4 caught the 31-file state on a monitor, measured it, **announced a rotation and ordered nine sessions to
re-bind** — and it had already been reverted. **Four of its workers refused the order** and reported the
disagreement against the announcement rather than adopting the number. One named it exactly:

> *A worker who re-binds on the coordinator's message rather than its own measurement records an identity
> that does not exist — the proxy-for-property error arriving through the announcement channel itself.*

**This closes a hole the full-program coordinator opened.** Both waves had been told to announce rotations
so gates would not detect them from file timestamps — correct as far as it went, and it **quietly implied
the announcement was the source of truth.** It is not. **Announce to TRIGGER a re-measurement, never to
SUPPLY the number**, and say *"measure it yourself"* explicitly in every rotation announcement.

**Small class worth carrying:** W4's monitor was **not wrong** — it observed a real state. **A true
observation with an expired timestamp is indistinguishable from a current one unless the consumer
re-measures.**

**Disposition.** `033` returns to its own author for the one-line fix and **nothing else** — the pin logic,
the three explicit NULL branches, the oracle removal and the measured truth table all stand verified. **A
delivery defect, not a design defect**, so the hash rotating for it is legitimate rather than cosmetic and
is consistent with §21.2's *do not rotate a hash to signal work*. Chain remains **28 files /
`8c5227dfe17923c2`**; nothing was announced to W4, so nothing needed retracting there. `034` is **not**
landed, so the `tracking.refresh` multi-Space 403 and the four known-by-design server reds are **still
live** — W4 correctly retracted its "may now be fixed" guidance, since **priming a worker to read a
persisting real defect as a stale measurement is the expensive direction of that error.**

## 23. Program terminates after W4 — no W5 (2026-07-27)

**User ruling: the program stops after W4.** No independent real-Server CLI verification wave, no agentic
CLI wave, no G5. **W4's completion is the terminal deliverable**, which raises the bar on the G4 statement:
there is no later wave to catch what it misses, so anything left open is left open **permanently** and must
be recorded as permanent, never rounded to done or deferred to a wave that will not exist.

**Chain landed and rotated: 31 files, `7e42a0d58f7b555d`** (from 28 / `8c5227dfe17923c2`) —
`032 74cc4e34…`, `033 3ee5e036…`, `034 ddfa9821…`. Landed inside an announced exclusive window with the
gate run before announcing. Full-chain gate 2/2; `w2-entities-commands-tracking.pg.test.ts` **24/24 — the
four `tracking.refresh` multi-Space 403 reds are gone.** Verified from **four independent vantages**
before announcement, including a W4 worker that migrated a scratch database through the full chain and
booted a real Server on it (`operations=100 registered=97`) **from a vantage that never read the new
file** — *"the author fixed it and the gate passes"* versus *"the runner accepts it and a Server runs on
it."* **G13 also composed: `entity feed` and `entity context` exit 0. `presence.get` is the ONLY 501 left
in the catalog.**

**Quiesce amendment, adopted:** the landing wave *"treated ANNOUNCING the quiesce as the barrier when the
barrier is the other wave REACHING a stopping point."* Next landing waits for an explicit **all-quiet**, no
fixed delay. Same shape as §22.4 — **a speaker's act mistaken for a world state.**

### 23.1 THE LINT I MANDATED WAS WRONG — TWICE — AND I FOUND IT BY BUILDING IT

§22.2 required *"a static check that fails when any file's `set role` count does not match its `reset role`
count."* Both halves of that specification are defective.

**Defect 1 — the obvious implementation is worthless AND WOULD HAVE PASSED ITS OWN MUTATION TEST.**
`reset role` **contains** the substring `set role`, so `grep -c "set role"` matches every reset line too.
Run naively across the landed chain it reports **all 31 files unbalanced at set=2 reset=1** — pure
artifact. Now apply the acceptance criterion that was given with it — *red on `033`-as-it-was, green on
`033`-fixed*: **the naive lint IS red on `033`-as-it-was. It passes the mutation test. And it is red on
everything, forever, proving nothing.**

> **A DETECTOR THAT FIRES ON EVERYTHING PASSES A MUTATION TEST EXACTLY AS WELL AS A CORRECT ONE.** The
> mutation test proves the detector **responds** to the defect, never that it **discriminates**. The
> missing half is a **NEGATIVE CONTROL**: the detector must be shown **green on the known-good baseline**,
> not only red on the known-bad case. This is a hole in how every detector built today was validated.

**Defect 2 — count equality is the wrong invariant, and the chain already disproves it.**
`015_w1_foundations.sql` has **one** `set role` (`:24`) and **two** `reset role` (`:2188`, `:2211`); a
redundant reset is a harmless no-op, so **a counts-match lint fires on correct code**. And
`001_core_graph.sql` trips any naive pattern on a **comment** at `:43`.

> **The real invariant is not count equality. It is: THE FILE MUST NOT TERMINATE WHILE STILL ELEVATED** —
> which is exactly the failure, since the runner's post-apply insert into `applied_migrations` executed as
> `tm8_graph_owner`. Extra resets are fine; ending elevated is not.

Corrected specification: a state machine over non-comment, non-string lines tracking elevated across
statement-anchored `set role`/`reset role`, asserting **not elevated at EOF**. Acceptance: red on
`033`-as-it-was, green on `033`-fixed, **and green on all 31 landed files including `015` and `001`.**

**Fourth time in one session that a specification was the defect — and the first time the specification was
a DETECTOR. "Verify the instrument" extends to the instruments we order built.**

### 23.2 SEQUENTIAL FIXTURES REPORT CLEAN GREEN ACROSS EVERY DEFECTIVE PAGING SITE

W4 measured `collections.query` and **its two assertions disagreed on the same row**: exactly-once
**PASSED** (6 seeded, 6 returned, 6 unique, paged at `--limit 1`) while precision **FAILED** (3 fractional
digits, not 6). **A symptom test walked straight over a proven-defective site and reported clean green.**
The other wave hit the mirror image on `spaces.awards`.

**Mechanism:** truncation only *loses* rows when two rows **share a millisecond and straddle a page
boundary** — which requires a **same-transaction or concurrent** fixture.

**This falsifies §21.5's third cursor direction as a sufficient test.** "Follow `nextCursor` to exhaustion,
exactly once, terminates" **can pass on a site already proven defective.**

> **ADOPTED, SUPERSEDING IT: THE MECHANISM ASSERTION IS PRIMARY, THE SYMPTOM ASSERTION SECONDARY.**
> Six-digit fidelity read off the wire cannot be fooled by fixture luck; exactly-once can. Any row closed
> on an exactly-once green **alone** is reopened and re-closed on a precision assertion.

**The `iso()` trap, which threatens immunity verdicts already banked.** `iso()` at `entity-read.ts:179`
truncates on **both** branches, so it **destroys precision that already survived as a string**. Therefore
**formatting microseconds in SQL is NOT sufficient for immunity** — a site that formats correctly and then
passes through `iso()` is still broken, and **a sweep that only changes SELECT lists will miss it.** The
verification wave had recorded `edges.list` and `entities.connections` as immune on exactly that mechanism;
both must be re-verified along the **full call path to the wire.** Cross-wave catch — the reason both waves
report to one place.

`collections.query` and `entities.feed` **confirmed truncating**, routed server-side. `spaces.awards` is
the **DESC silent-skip** shape, traced but **not reproduced** because award events are unreachable from the
CLI surface — **and that worker's test says so and refuses to pass rather than comparing undefined to
undefined.** *An unreachable case must produce a refusing test, not a vacuous green.*

### 23.3 Two coordinator errors, both caught by workers who checked the source

**W4's guard-flag table was wrong on three of seven rows** — `spaces.defaultChannel.set` transposed (its
field is `expectedSettingsRevision`), `projects.associations.correct` mis-derived, and
`spaces.menu.update` **omitted entirely**, a seventh guard-bearing row. The two transposed fields **differ
by one word and belong to the same group.** Its own assessment: *"that is exactly the collapse I had
lectured the wave about after the 12-vs-11 hint proved blind — and I then built the corrective table the
same careless way."*

> **A CORRECTION PRODUCED BY THE SAME MECHANISM THAT PRODUCED THE ERROR IS A SECOND DRAW FROM THE SAME
> DISTRIBUTION.** The grep-based count was wrong; the hand-built corrective table was wrong the same way;
> **runtime introspection — a different mechanism — got it right.** A correction must change mechanism, not
> merely change author or increase care.

**New rule, adopted alongside §22.4:** **AN INSTRUCTION IS EVIDENCE, NOT AUTHORITY; THE SCHEMA IS THE
AUTHORITY.** Same failure as the announcement rule, different subject; workers caught both.

### 23.4 Ruling — `projects.associations.correct` keeps `--expect-version`

The owning worker quoted **both** primary sources: dossier **§7:335** spells the flag `--expect-version`,
and the **same document at §4:123-127** names the field `expectedArtifactVersion`. **The dossier knew the
field name and chose the shorter flag deliberately**, so under §21.4's rule the authority wins. Verified by
runtime introspection, not grep.

**Uniformity amendment DECLINED.** Changing §7 rotates the approved dossier hash and requires a fresh
narrow Opus gate; spending a gate to make one flag rhyme with its field is the worst cost-benefit trade
available, and *"make it uniform"* is the same instinct as *"use the query string, it's already
precedented"* — a surface changed because it was tidy rather than because it was wrong.

**But the risk is not the inconsistency, it is a future tidier "fixing" it.** This is now the **one row in
the program where the flag does not kebab-case its field** — exactly what someone later notices and
normalises, silently breaking a dossier-specified surface. **Required: the derivation's implementation
carries an explicit exception entry citing §7:335 and §4:123-127 by line**, so the deviation is
self-documenting and a change to it **fails a test** rather than passing review as cleanup. The EXACT-SET
quarantine is the right shape — it goes red in both directions, which is what an intentional exception
needs.

### 23.5 Integration coverage — the category error and the better answer

The full-program coordinator read *"8 integration files against 26 modules"* as a coverage gap. **Category
error:** five modules are infrastructure (`completion`, `help`, `registry`, `search`, `worker-init`) and
integration files are organised **per group** — so it is **8 files for 8 groups**.

**W4 refused to let its own correction stand as reassurance**, which matters more than the correction: it
tried to verify per-operation coverage statically and **could not**, because many invocations are built
dynamically. *"A per-group file proves the group has a real-Server file; it does NOT prove every operation
in that group was exercised."*

**Hard G4 requirement:** a **per-operation coverage declaration** — one line per operation,
`EXERCISED-REAL-SERVER | UNIT-ONLY | NOT-COVERED`, with a reason for anything not real, **measured, never
inferred from file names.** With no W5, **that declaration IS the program's coverage record.**

### 23.6 G10 rulings — the fifth frame, and refusing to buy a zero

Conditions 2 and 3 of §20.1 **discharged by measurement**: catalog digest `sha256:df96ff5a…` **unchanged**,
`OPERATIONS` 101 → 101, conformance manifest `062ec620…` identical would-be versus on-disk. No catalog row,
no operation, no return to arbitration.

**A fifth frame was authorised.** The four ruled frames gave a presence-channel **toggle with no presence
WRITER**, so `presence.get` would have returned an empty snapshot for every entity forever — *"a data-loss
bug wearing a green badge."* **Driving the residual count to zero by making an operation lie would have
been the worst trade in the program.** Not a fifth requirement: the four-frame set was **under-counted
against the three adopted requirements**, so the same §20.1 authority covers it. Creates no table; DEV-4
keeps presence ephemeral.

**The server→client refusal ACK was approved on a coherence argument** that is itself the ruling's
justification: a silently-refused subscribe is indistinguishable from an authorized-but-quiet Space — **the
identical dishonest-surface defect just rejected for the empty `presence.get`. Rejecting one while shipping
the other would be incoherent.** `schemaVersion` **denied** as speculative with no adopted requirement.

**Third distinct subject for the stale-artifact-as-instrument class (§21.3):** `generator.ts:284` takes its
counts from a **frozen W1-era snapshot** rather than the live tree (manifest 23/1/28 against a live
92/1/97), so **anyone reading those `assertEqual` lines predicts a rotation that cannot happen.** A risk
note, a design doc, and now a generated manifest's own assertions.

### 23.7 B1 done — the red was worse than "no guard"

12/12 with a real archived red first, and the red's content matters: **all seven public caller shapes
resolved 200 with a real PTY write.** So `execution.prompt` was **a working public prompt route, not a
missing check** — *a missing guard is a hole; a working route is a feature nobody meant to ship.* Fixed
with one statement, no branch, no ordering for a later edit to get wrong.

### 23.8 HARVESTABILITY: the severity reduction is FALSIFIED BY MEASUREMENT

**A `clientMutationId` IS harvestable, measured, through five composed read routes** — `entities.get` on a
message, `messages.list`, `entities.feed`, `entities.context`, `collections.query` — **and two of those did
not exist before tranche-v3.**

**§14A's severity phrasing rested on non-harvestability and is now false, not merely superseded.
"Reachable but not self-serving" is RETIRED** — not "true today", not tense-sensitive: **retired.** Anyone
writing it is describing a state that has been measured false.

**And the shape is worth keeping: the program PREDICTED this would become true and then MADE it true
itself, deliberately, in §19.3.** That is the correct way to take a knowing risk — and it stays correct
only if **the moment of transition is recorded as loudly as the prediction was.**

### 23.9 The two PERMANENT gaps (no W5 means no later closer)

1. **NO INDEPENDENT EXECUTABLE RACE HARNESS WAS EVER BUILT.** `033`'s race-correctness rests on its
   author's own two-connection test plus a read-only adversarial sufficiency review. Standing it down
   (§19.1) remains the right call — it bought the composition that turned 25 dead operations live — **and
   the trade must be visible rather than implied. A trade recorded only as its benefit is not a recorded
   trade.**
2. **"1 is a VERIFIED LOWER BOUND, not a proven exact count"** is the permanent record for the 94-of-97
   gated sweep, with its single-reader status and its two known false positives stated inline, not
   footnoted.

**Explicitly NOT moving to permanent** — in scope and closing now: the cursor-truncation class, the
eight-site sweep, and `xg02`'s red. *A list of exceptions with no stated remainder is unreadable.*

### 23.10 The disk slope was misattributed — by both coordinators and by the full-program coordinator

Both waves had reported a monotonic decline (18 → 15 → 14 → 13 → 12.7 → 10.6 GiB) **as if it were the
program's consumption.** Measured to source instead:

```
/Users/subhang/.tm8-dev (postgres)   765 MB      all tm8_* databases   645 MB
/private/tmp/claude-503 scratchpads  339 MB      the repository        287 MB
TOTAL, BOTH WAVES, EVERYTHING       ~1.4 GiB     against a ~7 GiB drop
```

At most a fifth is attributable, **and that fifth includes postgres and the repo, which predate the
program and do not grow per-run.** Per-run scratch churn is a few hundred MB, **cycling rather than
accumulating.**

**The decisive datum, added on re-measurement: FREE SPACE WENT BACK UP** — 10.6 GiB reported, 11 GiB
measured shortly after. **The slope is not monotonic.** A number that reverses while fifteen sessions keep
running DB-backed suites is conclusive that the driver is external, because our own consumption only ever
adds.

> **A MEASUREMENT WITHOUT ITS ATTRIBUTION IS A RUMOUR WITH A NUMBER ATTACHED.** §15's scope-discipline rule
> turned on the program's own hygiene reporting. Fifth instance of the signature failure in one session and
> **the first aimed at ourselves rather than at the product** — all three coordinators had been propagating
> a real number with an unmeasured implied cause.

**Why it mattered rather than being a footnote: a wrong attribution here would have throttled real work for
nothing.** Ruled: W4 **keeps** sequencing full-suite runs — that decision stands on its own merits, since
cross-run interference at ~36 concurrent scratch databases reads exactly like a real defect in a worker's
own code — but **no further disk-motivated throttling.** Floors unchanged at 150 MiB abort / 200 MiB
escalate.

**The 20 orphans stay.** `tm8_w1_w3_agentic_*`, from W3 agentic sessions terminated on usage limits; dead
owners, ~240–280 MB, the only genuine leak among 50 `tm8_*` databases. Dropping another session's database
is precisely the unilateral destructive act a coordinator should not take. **Reason neither wave stated:
nobody has verified those 20 hold nothing of evidentiary value** — §8.1 says unrecorded work is *triaged*,
not deleted, and 280 MB does not buy a triage. **The correct disposition for a cheap unknown is to leave it
and record it.** Live sessions on both sides now verify teardown against `pg_database` rather than trusting
`afterAll`; the orphans predate that discipline.

**Reporting format adopted: HOST slope, never "our consumption", with the program's footprint stated
alongside — and never again without its attribution.**

### 23.11 An irreversible delete, ordered by the full-program coordinator, framed as a measurement

**20 `tm8_w1_w3_agentic_*` orphan databases were dropped.** `tm8_*` count 51 → 32; remaining orphans of
that prefix: 0. Irreversible. Reported by the closure wave **immediately and unsoftened**, before the
full-program coordinator could have noticed.

**The instruction was the full-program coordinator's, and its FRAMING was the defect.** Verbatim: *"REAP
ORPHANED SCRATCH DATABASES NOW AND REPORT THE COUNT BEFORE AND AFTER. If before and after are equal, that
is a useful negative result."* That sentence orders a **deletion** and immediately reframes the action as
a **measurement** — *"report the count"*, *"a useful negative result"*. It reads as instrumentation. An
irreversible destructive act was buried in a hygiene paragraph at the end of a message about the `iso()`
trap, with the word **NOW** attached.

> **NEW CLASS: A DESTRUCTIVE INSTRUCTION FRAMED AS A MEASUREMENT INSTRUCTION.** The recipient reads
> *"report the count"* and executes *"drop the databases"*. The framing makes the destruction incidental
> to the reporting, which is how it got executed without the pause it deserved.
> **Adopted: a destructive instruction is issued ALONE, NAMED as destructive, and never bundled into a
> hygiene, measurement, or status paragraph.**

**The coordinator's self-blame was misallocated in one place, and the record should not stand as it wrote
it.** At the moment of execution, the only thing the action reversed was **its own recommendation**, not
any ruling — the "leave them" ruling had not been sent and crossed in flight. **Deferring to the
full-program coordinator's explicit, recent, imperative instruction over one's own recommendation is the
correct default**, not a lapse. **And there was a recorded precedent it did not claim:** W3 had already
dropped exactly this class of orphan and written it up as routine —
`W3-PUBLIC-AND-AGENTIC-EVIDENCE.md:374` (*"no user or development database was touched"*), corroborated
at `W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md:418` (*"the only genuine orphan… dropped by W3 itself.
Zero leaks on either side"*).

**The verification the wave could no longer perform was done by the full-program coordinator instead.** A
sweep of every evidence document, package and tool for references to those databases returns **only the two
precedent lines above plus this document's own entry — all of them naming such a database as an OBJECT OF
CLEANUP, none as a SOURCE OF DATA. No recorded artifact in this program depends on the contents of any of
the 20.** So *"probably nil"* upgrades to **nil with respect to everything the program recorded** — with
its limit stated: this proves nothing *recorded* depends on them; it cannot prove none held un-recorded
state someone would have wanted. **But un-recorded state that nothing references is precisely the case
where §8.1's triage would have found nothing to triage.**

**The durable rule, and it is the wave's, generalising far past databases:**

> **"IS IT SAFE" AND "IS IT LOSSY" ARE DIFFERENT QUESTIONS, AND ONLY THE EASY ONE GOT ASKED.** Safety is
> whether the action will succeed and stay in scope — checkable in seconds, and it *was* checked here
> (zero active connections verified, drop scoped to the exact prefix). Lossiness is whether anything
> irreplaceable goes with it, and it requires knowing what you have. **Every destructive act now answers
> both, separately and in writing.**

**Trigger amended:** flag before executing when *"this is irreversible and I did not create it"* — **not**
when *"this contradicts a prior ruling."* The narrower trigger would not have fired here, because at
execution time there was no ruling to contradict.

**Not a stop-the-line.** 264 MB recovered, no recorded loss, a precedented action, executed on an explicit
order with correct scoping. The cost was one governance rule each — and **reporting it immediately and
unsoftened is what makes the rest of the wave's reporting trustworthy.**

### 23.12 XG03 — same-principal RESOURCE CONFUSION at `entities.create`, and the chain it completes

**Measured at the HTTP boundary on the landed 31-file chain, not inferred.** `POST /v2/entities` naming
**Space B**, replaying a `clientMutationId` recorded against **Space A**, **same principal**:

```
status 201, errorCode null
returnedEntityId == originalEntityId
returnedSpaceId  == spaceA, NOT spaceB
nothing created in Space B
```

**The caller named Space B and received Space A's entity under a 201.**

**Positive control passed in the same test** — the same principal replaying the same cmid at the **same**
Space still gets its stored entity back byte-identical. **That is what makes it a CONFUSION finding rather
than broken idempotency: the mechanism is not refusing everyone, it is failing to distinguish resources.**

**Nobody's defect — both guards behave exactly as designed.** `entities.create` is not one of `032`'s
seven, so it has **no resource binding**; and `033`'s pin is **principal-only and PASSES**, because Phase-1
has exactly one loopback identity, so attacker and victim are the same account **by construction**. *A
defect that emerges from two correct components meeting a platform constraint is not an implementation
failure, and writing it up as one would misdirect whoever picks it up.* This is the residual flagged when
the batch landed — *"same-principal resource confusion at any site `032` did not cover remains open"* — now
**executed rather than predicted**.

**THE CHAIN, which is the actual finding.** XG02 proved a cmid is **readable off five composed routes**
(§23.8). XG03 proves a replayed cmid at an unbound site returns another Space's entity under a 201. So the
attacker needs to guess nothing and obtain nothing out of band: **read a thread, take a cmid, replay it at
`entities.create` against a Space you do not belong to, receive that Space's entity.** Every step is
same-principal, **so nothing in `033` fires.** A cross-Space read primitive on the public API, assembled
from two independently measured facts.

> **THE SEVERITY OF A COMPOSED CHAIN IS NOT THE MAXIMUM OF ITS PARTS.** Harvestability was batched as
> low-severity into G0.2; same-principal resource confusion was recorded as an accepted residual at
> landing. **Both halves were separately assessed and separately deprioritised, and nobody was wrong about
> either half.** Adopted: **a residual accepted in isolation must be re-read whenever a second residual
> lands near it.**

**Severity with its conditions, stated by the gate and not widened:** nothing is deployed, there is no
second principal at the Phase-1 boundary, and therefore **no real victim exists today**. *The tense is
load-bearing — and it is the same tense that was load-bearing about harvestability this morning, which went
from "true tomorrow" to "measured true" in about four hours, by the program's own deliberate act.* The
record of how fast the last set of conditions expired is part of the statement.

**Scope: ONE site measured.** Every other ledgered site with a resource-carrying stored projection is a
**candidate**. The gate **explicitly refused to extrapolate a count** — endorsed; *enumerate, do not
estimate.*

**RULING — build for the measured site, hand off the tail, but COMPLETE THE ENUMERATION.**

- **`entities.create` is FIXED NOW.** The usual objection to fixing as a program ends — *who verifies it
  with no W5* — **does not apply**: the acceptance criterion already exists and is executable. **XG03 is
  written, red, independent, authored by the gate rather than the implementer, and carries its positive
  control. XG03 flipping red→green with the positive control still passing IS the verification** — a
  stronger close than much of what shipped *with* a verification wave. The implementer does not touch XG03.
- **The tail: neither build nor plain hand-off.** The two halves have opposite answers because
  **KNOWLEDGE DECAYS AND IDIOMS DO NOT.** A future implementer can apply a proven idiom to a named list in
  an afternoon; they **cannot cheaply rediscover which sites need it** — that needs the full-chain context,
  the class-D framing, the `032` pattern and the two-doors insight, all of which live in this session and
  nowhere else once it ends. **So SEC-1 Stage 2's ENUMERATION completes** (read-only, bounded, already in
  flight) **and the FIXES hand off**, as a named list with the idiom cited by file and line and **XG03
  attached as the executable template for what a proof of the fix looks like.** *Enumerating is not
  fixing.*
- **Guard against authorizing an unbounded set by instalments:** if the enumeration names further sites
  that are **both composed and carry a resource-bearing stored projection**, the count and list come back
  for a separate ruling. **One measured site is authorized, not a class.** *"While we are in here" is how a
  bounded fix becomes a wave.*

### 23.13 An item held in TWO STATES because its two statements had different audiences

The closure wave told the full-program coordinator *"NO INDEPENDENT EXECUTABLE RACE HARNESS WAS EVER
BUILT… that is a PERMANENT gap"* and, in the same session, told its verification worker *"ALSO YOURS, FULL
SCOPE: the concurrent harness scoped to the 92 unpinned sites."* Both are in the record; they cannot both
be operative. **A worker caught it, not the coordinator.**

> **NEW SHAPE, adjacent to descope but distinct.** A descope survives a re-scope because removal is
> explicit and restoration is one word. **This survives because NO SINGLE READER SEES BOTH HALVES, so there
> is nobody for whom the contradiction is visible.**

**The structural cause is the topology, not anyone's attention.** Every coordinator states status **upward**
to the full-program coordinator and **downward** to workers, so **every status in this program has two
audiences by construction** and this class is available at *every* status change.

**Countermeasure — the wave's version was right but weak** (*"a status change must go to everyone who holds
the old status"* depends on remembering who holds it, the same faculty that failed). **Adopted, stronger:
ANY ITEM MOVING BETWEEN IN-SCOPE AND PERMANENT-GAP IS WRITTEN TO THIS DOCUMENT AS THE SINGLE SOURCE, AND
MESSAGES REFERENCE IT RATHER THAN RESTATING IT. A restatement can diverge; a reference cannot.** Binds the
full-program coordinator equally — it had been restating rulings into two channels all day.

**Resolved: the harness stays OUT.** The six acceptance conditions were withdrawn **explicitly**, rather
than left binding on a task nobody is doing. **The worker's handling is the model: it treated the six as
STILL BINDING until explicitly withdrawn, and flagged rather than silently reinstating or silently
dropping. FLAGGING IS THE ONLY CORRECT THIRD OPTION WHEN A COORDINATOR'S INSTRUCTIONS CONFLICT.**

### 23.14 The parked-attacker assertion is UNSCOPED — the race claim is downgraded to UNPROVEN now

In **both** the landed `031` suite (`:466-467`, `:661`) **and** the `033` suite, the parked-attacker
assertion is an unscoped `select count(*) from pg_locks where locktype=advisory and not granted` — **no
pid, no lock key, no database filter**, against a **cluster-wide** view, **while a parallel wave runs on the
same host**. Any ungranted advisory lock held by any connection to any database satisfies it.

**Precisely what it can and cannot do — this must not be flattened into "the test was broken", because it
was not: IT CANNOT PRODUCE A FALSE GREEN OF THE SECURITY PROPERTY, BUT IT CAN PRODUCE A FALSE CLAIM OF RACE
COVERAGE** — satisfied on iteration zero by a foreign lock, then committing before the attacker reaches
`ledger_replay`, **passing as a sequential test wearing a concurrency label.**

**RULED: the race claim is marked UNPROVEN in the record NOW, not after remediation.** Not *"proven, pending
a tightening."* If the tightening lands and passes, upgrade it. **A record that waits for the fix to tell
the truth lies for exactly as long as the fix is pending — and with no W5 that could be permanently.**

**Two supports for one property, and both have now failed inspection:** the harness was never built (§23.9),
and the assertion the existing suites use instead is unscoped. **Both halves go in the handoff together,
because either alone misleads** — a reader seeing only the first thinks the existing suites cover it; a
reader seeing only the second thinks a harness will catch what they miss.

**Fix scoped:** ~10 lines at three sites — capture `pg_backend_pid()` on the attacker, read the victim's own
**granted** advisory `(classid, objid)`, require the attacker's ungranted row to match both. Sequenced
behind the per-branch tranche-v3 matrices (product coverage is the last independent look and outranks
evidence repair), **with a floor: it runs, or it hands off as a NAMED SUSPECT CLAIM with the three sites and
the exact fix cited.** **If tightening turns either suite RED, that is the MORE valuable outcome** — it
would mean a race claim treated as proven was never proven, found by us rather than by whoever ships this.

> **THIRD GREEN TODAY RESTING ON AN ASSERTION THAT COULD NOT DISCRIMINATE** — the always-red lint (§23.1),
> the exactly-once symptom test that walked over a defective site (§23.2), and now a synchronization barrier
> satisfiable by unrelated noise. **Named class: A CONDITION SATISFIABLE BY SOMETHING OTHER THAN THE THING
> IT IS CHECKING FOR. Every gate sweeps its own barriers for it.**

### 23.15 "One measured site" was ELEVEN FUNCTIONS — and two delivered bindings are bypassable today

**Measured from live `pg_catalog` on the applied 31-file chain.** `entities.create` is **one label with
eleven granted doors**: `create_task`, `create_channel`, `create_collection`, `create_document`,
`create_team_member`, `create_file_entity`, `create_spell_entity`, `create_skill_entity`,
`create_pull_request_entity`, `create_commit_entity`, `create_custom_entity`. **Every one has a bare-return
replay and every one stores a resource-bearing projection** carrying entity id and `space_id`.

> **Binding only the door XG03 drives is SECURITY THEATRE** — the word stays. A caller uses another door.
> **And it would make XG03 GO GREEN while the defect remains fully open, converting the acceptance criterion
> into a false negative. A FIX THAT MAKES THE TEST LIE IS WORSE THAN NO FIX**: it does not merely fail to
> close the defect, it destroys the instrument that would have detected it — and with no W5 that instrument
> is the last one pointed at this.

**No shared chokepoint exists:** `ledger_replay` cannot see the addressed resource, which is exactly why the
**resource** half cannot be global the way `033`'s **principal** half is (§21.1). The fix is one
`require_replay_subject` per door binding replay `#>> {entity,space_id}` against `p_space_id`. All eleven
take `p_space_id` first and store the same projection shape — **the idiom is literally identical eleven
times**; 11 × ~6 lines against `032`'s 7 functions.

**TWO DELIVERED BINDINGS ARE BYPASSABLE — a FALSE CLAIM IN DELIVERED WORK, not new scope:**

| Label | Bound door | Bypass door | Status |
|---|---|---|---|
| `projects.update` | `update_project_w2` (bound by `032`) | `public.update_project` (`007`) — **granted**, bare return, stores `to_jsonb(project)` | **LIVE** |
| `spaces.update` | `w2_update_space` (bound by `031`) | `public.update_space` (`007`) — **granted**, bare return, stores its result verbatim | **LIVE** |

**Both doors granted in both cases makes these LIVE, not latent** — correctly distinguished from
`post_message` (§21.1), which is latent precisely because `tm8_app` cannot execute it.

**Full collision picture, measured:** 63 distinct labels across 98 live callers; **16 labels are
collisions, 12 of the 16 have more than one granted door** — `entities.create` (11), `entities.patch` (11),
`edges.create`, `projects.link`, `projects.unlink`, `projects.update`, `spaces.invites.redeem`,
`spaces.invites.revoke`, `spaces.taskAxes.create`/`delete`/`update`, `spaces.update`; four more are
single-granted-door latents. Protection tally across all 98: **UNBOUND 82 (79 granted), BOUND 13,
SELF-GUARDED 3.**

**RULED (c), with a boundary that cannot extend:**

> **WE FIX WHAT WE FALSELY CLAIMED. WE DO NOT FIX WHAT WE MERELY FAILED TO CLAIM.**

`projects.update` and `spaces.update` were **claimed bound** by delivered, recorded work — that is
**repair**. `entities.patch` was never claimed, so it is **new coverage** and goes to the handoff. The line
is finite and enumerated **by construction**: the set of false claims is closed, so it cannot creep.
`entities.patch`'s eleven doors are **NOT** authorized — unmeasured, XG03 does not drive them. The wave drew
that line itself and asked to be held to it; **held.**

**The two actions are SEPARABLE and only one is a judgement call. The record correction is not optional and
does not wait for the fix:** `031` and `032` currently assert those labels are bound; they are not. Marked
as false claims **today**, bypass door named — same ruling and same reason as §23.14. *A record that waits
for the fix to tell the truth lies for as long as the fix is pending.*

**CONDITION before the fixes land.** The whole boundary rests on the false-claim set being **closed and
enumerated**, and *"exactly two"* is the **reassuring half** — §14A.2's shape. **A named second reader is
required on that set specifically:** for every label carrying a BOUND door, is there any granted UNBOUND
sibling? If it returns three or four, it comes back for a fresh ruling rather than being absorbed.

**FOURTH INSTANCE OF THE SIGNATURE FAILURE, AND IT IS THE FULL-PROGRAM COORDINATOR'S.**
`spaces.invites.revoke` is the **only** two-door label where **both** doors are bound — and it is complete
**because the full-program coordinator ruled the unrouted sibling IN when the wave proposed dropping it.**
*The same ruling applied twice more would have closed these two.*

> **The correct call was made on one label and nobody asked whether it generalised** — the exact class this
> program had already named (*a defect found in one group is evidence about a class, not an incident*), the
> same shape as the replay guard converged on four times and the microsecond cursor named once in the §4
> matrix. **The rule was written and then a fresh instance of it was produced by its author.** The cost is
> precisely the two live gaps. It is also the strongest evidence the fix shape works, since the one label
> that got the ruling is the one label that is complete.

### 23.16 O1 RULED — the obligation had been NARROWED IN RESTATEMENT; the contract was right all along

W4 escalated a genuine specification question rather than measuring around it: G11 established that in its
wiring **dispatch is awaited inside `postMessageBatch` before the handler returns**, so from the CLI's
vantage **the unsettled window is zero on a healthy node.** It went to the CHECK constraint rather than
reasoning from a status name:

```
015 session_message_deliveries_state_shape  →  UNSETTLED = exactly {pending, dispatching}
failed_retryable STAMPS settled_at — "retryable" describes the MESSAGE, not the ROW;
a retry is a NEW delivery_id with attempt_no+1.
```

So *"stored but UNSETTLED"* has **no healthy-path trigger**: pending/dispatching arises only from process
death or an adapter throw between reserve and settle — **fault injection, not a CLI-reachable condition.**
W4 asked whether to record O1 as unreachable-by-design or to redefine it, and correctly refused to decide.

**RULED from the frozen authority, not from judgement — and it is unambiguous in five places, including
the CLI's own source:**

```
packages/cli/src/exit.ts:44   "stored, but a requested delivery is INCOMPLETE/NON-DELIVERED"
packages/cli/src/exit.ts:65   "incomplete OR NON-DELIVERED (--wait settled only)"
GRAMMAR :470   "exit 11 only when a requested delivery is NON-DELIVERED **or** does not settle before timeout"
GRAMMAR :954   "incomplete OR NON-DELIVERED"
GRAMMAR :1089  "reserve exit 11 for INCOMPLETE --wait settled delivery"
GRAMMAR :1148  "with ONE NON-DELIVERED TARGET prints every stored message/outcome and EXITS 11"
```

> **The specification is a DISJUNCTION, and NON-DELIVERED is the FIRST disjunct — stated first in all five
> places, and it is the one the canonical acceptance scenario at `:1148` names.** *"Stored but unsettled"*
> is the **second** disjunct only. **The obligation never said that. It was NARROWED IN RESTATEMENT and
> everyone downstream worked from the narrowed version.**

**The narrowing was substantially the full-program coordinator's:** every packet said *"O1 — exit 11
end-to-end via `message send --wait settled`"* with no disjunction, and W4 built a correct obligation on an
incorrect restatement. **§21.3's class arriving in the place with the most leverage — except inverted: the
CONTRACT was right and the PROGRAM'S OWN RETELLING drifted.** W4's own rule — *cite the contract line,
never the restatement* — is what would have caught it.

**Disposition: implement the first disjunct, and record it as RESTORATION, not as a change of
obligation.** A work_session-anchored send to a session with no live PTY settles
`failed_retryable`/`no_live_terminal` — the first disjunct exactly, closable **deterministically with no
live agent and no fault injection**. *Anyone reading "redefined" will assume a goalpost moved; it moved
back.*

**The second disjunct is still recorded, as a finding:** exit 11's *does-not-settle* half is an
**error-path-only code with no healthy-node trigger** — a property of the design, discovered by
measurement, not a gap in the build. It belongs in the handoff **because the next person will try to test
it and needs to know why they cannot.**

**Two W4 judgements worth preserving.** It **refused to build O1 on the exited-work_session path**, which
produces exit 11 *today*: `019`'s exited-target branch writes a non-null source with all three `pair_*`
columns NULL, violating a CHECK, so the reservation rolls back leaving zero delivery rows. **The right exit
code for an entirely wrong reason, which disappears the moment `019` is repaired** — the archive-the-red
class **inverted: a PASS that a repair destroys.** And `isSystemDeliveryPrincipalFor`'s exact-own-keys check
over **four** keys against the adapter's **six** would have **refused 100% of deliveries forever**, so a
literal wiring would have shown zero rows and produced a false diagnosis of correct work.

**A class found independently by both waves:** a verbatim-string comparison across timestamp
representations is **a fidelity check PLUS an accidental format lock** — `07:15:43.619023Z` and
`12:45:43.619023+05:30` are the same instant with identical microseconds. W4 investigated before reporting
and found it in **its own test** rather than filing against the other wave's consolidation. **The guard on
the fix is the part that matters: assert first that the row has a sub-millisecond component**, because a
row landing on an exact millisecond lets a truncated cursor compare equal and the check goes vacuous —
§23.2's shape caught *prospectively*, inside the fix for §23.2's shape.

### 23.17 The pg_locks tightening landed — the race claim SURVIVED. §23.14 half-superseded.

**§23.14's downgrade was the right call and its outcome is the good one.** The unscoped cluster-wide
`count(*) from pg_locks where locktype=advisory and not granted` is replaced by a **join pinning both
backend pids and matching the lock key** — and elegantly, **the victim's own held lock supplies the key**,
so no `hashtextextended` arithmetic was needed. Both backends capture `pg_backend_pid()` immediately after
`BEGIN`. **39/39 across both SEC-1 suites at three sites. It did not go red.**

> **The race evidence for `031` and `033` was SOUND AND PREVIOUSLY UNDER-EVIDENCED, NOT WRONG.** The
> attacker genuinely parks on the victim's exact lock; the assertion now *proves* that rather than merely
> being *consistent with* it.

**Validated in both directions per §23.1's negative-control rule:** the gate mutated the assertion to pass
the **victim's** pid where the attacker's belongs — the victim holds only *granted* locks, so a correct
detector must find no match — and it went **RED with the exact diagnostic naming both pids**. Reverted,
re-run 39/39, byte-restoration confirmed by grep. **Red on known-bad, green on the real configuration.**

**A countermeasure to §23.16's renamed-caveat class, arrived at independently:** on timeout the assertion
throws with both pids and the message *"the race was NOT exercised and any pass below would be
sequential."* **The caveat now lives in the failure diagnostic — read at exactly the moment it matters —
rather than in a test name that a rename can delete.** A future failure states what it means instead of
reporting a bare false.

**⚠ THE FIRST HALF OF §23.9 REMAINS PERMANENT AND MUST NOT BE SOFTENED BY THE SECOND.** *No independent
executable race harness was ever built.* What exists is **a better-scoped version of the same
implementer-adjacent suites**, which is not an independent harness. **A reader who sees "tightened and
green" could take the gap as closed. It is not.** Both halves are still read together; only the second
half's content changed.

**Corrected entry, for §23.9 and for the close document:** *"No independent executable race harness was
ever built — that trade was made deliberately to buy the tranche-v3 composition. The assertion the existing
suites use to claim race coverage WAS unscoped and HAS NOW BEEN TIGHTENED to pin both pids and the lock
key; it was re-run and the claim survived, so the prior evidence was under-evidenced rather than wrong."*

**Note the reporting shape:** the wave **flagged rather than edited** the close document, because that
document belongs to another author — and because *"leaving it as-is would be exactly the class we have been
naming all day: a state I changed, described by an artifact nobody updated."* §23.13's single-source rule
working as intended.

## 24. PROGRAM CLOSED — both waves reported (2026-07-27)

**W4: G4's literal criterion is MET.** 48 files / 1150 passed / 1 skipped / **exit 0**, builds RC=0
unpiped, chain bracketed identical before and after. Both deliberate witness tests went green **on their
own** when their server-side defects were fixed — no CLI code and no CLI test changed. **The single skip is
`it.skipIf(unwired.length === 0)`: it skips BECAUSE every command is wired** — the only skip in this
program that means its own opposite.

**O1 CLOSED, measured end-to-end on the built binary:** `exit=11 mode=binary` with a real reserved delivery
row — `status: failed_permanent`, `attemptNo: 1`, `settledAt` stamped. **The contract's FIRST disjunct**
(`exit.ts:44`, `GRAMMAR:1148`). **No synthetic state, no fault injection, no live agent.**

**The earlier zero-rows observation was A STALE BUILT ARTIFACT** — G11 had named exactly two surviving
shapes and this was the second. A `dist` predating the wiring has no `messageDelivery`, never calls
`reserve`, throws nothing, and returns exit 0 with zero rows — **every observation in the first report, with
no remainder.** **Nobody's code was ever broken:** not a credential, not a role, not a database, not an
exception. **The binary was old.**

> **A MEASUREMENT OF A BUILT ARTIFACT IS NOT A MEASUREMENT OF THE SOURCE, AND NOTHING IN EXIT 0
> DISTINGUISHES THEM.** The program's own class, one last time, on its last measurement.

**An abandoned instrument is now proven correctly abandoned.** The full-program coordinator had ordered a
log inside the delivery `catch`; both authors argued it was the wrong instrument because **it fires only
when something throws** — and the never-invoked world was the actual one, so it would have logged nothing
and taught nothing. **The outcome settles the argument in their favour.** What replaced it — G10's startup
line distinguishing `wired` / `NOT CONFIGURED` / refuse-to-boot-on-wrong-role — separates three worlds in
the first second of output where the log separated none.

**The condition travels with the green, permanently:** a **hand-supplied local credential** on a dev cluster
whose `pg_hba.conf` is TRUST for `127.0.0.1/32` — **a property of this cluster, not of the product. NOT a
green on a default configuration.** At default the variable is unset and *"no delivery rows"* means
**UNCONFIGURED**, not undeliverable.

**And the thing that outlasts O1: this is the FIRST AND ONLY observation in this program of B2's delivery
path actually executing.** Everything else about B2 was proven at the DB and unit layers with nothing in
production having invoked it.

**W1–W3 CLOSED.** Chain 34 / `a799b7ef1b20a9b0`. Server suite excluding `test/w3`: 65 files / 702 tests /
zero failures. Contract 42/42. Test-file typechecks clean. Zero leaked scratch databases. Seven migrations
landed today, **each gated before announcing**; two attempts failed and were **reverted inside their
windows**, costing nobody a poisoned verdict. The one-identity-path guard **sharpened** — named caller
claims in exactly one file, other namespaces allowlisted at the cost of a recorded decision, and **local
scope now checked in every binder that exists or ever will, which was checked nowhere before.**

**G3 readiness recorded conditionally, with its limits in the record** — every v1 non-WS operation is
**MOUNTED**; *"implemented"* is **not supported**; the schema-valid sweep of all 98 has never been run.

### 24.1 The closing synthesis

> **THE EXPENSIVE ERRORS WERE NEVER WRONG FACTS. THEY WERE CORRECT MEASUREMENTS WHOSE SCOPE OUTRAN WHAT
> PRODUCED THEM.**

A residual count proving operations **mounted**, read as **implemented**. A true database figure framed as
**reclaimable**. An accurate all-quiet treated as a **standing state**. A migration correct and **inert**
because the layer above collapsed the distinction. A control safe as a **query** and destructive as a
**boot**. A green measuring the **binary** rather than the **source**. **Every one was a true sentence with
a false neighbour, and the neighbour is what got acted on.**

**Fourteen coordinator figures were challenged today and fourteen fell. Every one fell to somebody opening
the file.**

And the reason any of it recurred is §23's last finding: **the knowledge was already in the tree.** Not one
recurrence was a gap in understanding. **A comment prevents the bug in the file it is written in and nowhere
else** — which is why a detector beats a rule, and why the operational form is: **wire it to something that
fails.**

### 24.2 A FALSE CAVEAT, caught one hour after the guard that falsified it

W4 attached to its O1 closure: *"the wiring cannot enforce that the URL authenticates as the right role —
that stays a deployment fact the code cannot check."* **False as of today.** `verifyDeliveryPrincipal` is
awaited at `main.ts:134` **before `server.listen()`** and **fails the boot** unless `session_user` is
`tm8_delivery_worker` with `rolsuper` false.

**W4 quoted world C — "refuse-to-start on the wrong role" — ONE PARAGRAPH ABOVE writing that the code
cannot check it.** Two adjacent contradictory statements, **and the false one was the one phrased as a
DURABLE LIMITATION** — so it is the one that survives into a handoff while the true one reads as a local
detail.

**Not a measurement error: the STALE-CAVEAT class.** The sentence was **true when W4 wrote its O1 analysis
that morning and expired when the guard landed mid-investigation.** Fourth instance of *a true statement
whose subject got fixed underneath it* — and **the one that would have shipped in the close document as a
permanent limit.**

**`session_user` is the load-bearing choice, not a detail.** As superuser, after
`set local role tm8_delivery_worker`, **`current_user` reads `tm8_delivery_worker` while `session_user`
still reads the superuser** — so a guard written against `current_user` **would pass in exactly the case it
exists to catch.** The class, arriving inside the fix for the class.

**The residual was kept by both parties, because a correction that inflates a guarantee is its own
defect.** Recorded: the code cannot constrain *what an operator supplies*, only whether this node will run
with it; **mitigation, not fix — it protects THIS WIRING ONLY**; `015:1346-1347` is an `AND` still admitting
any principal permitted to assume the role; and the guard checks **which role authenticated, never HOW** —
the TRUST-auth caveat is separate and unaffected.

**⚠ AND THE DURABLE FIX IS BLOCKED BY A FINDING OF ITS OWN.** Tightening `015` turns
`test/db/w1-foundations.test.ts` and `test/db/w2-messages-handoffs.pg.test.ts` **RED**, because they reach
the delivery RPCs by `set local role` from the **superuser** scratch pool and **pass BECAUSE OF the hole**.

> **TESTS THAT PASS BECAUSE OF A SECURITY GAP ARE THEIR OWN FINDING**, and they must be fixed before the gap
> can be. Recorded as a permanent item, not as a deferral note.

**Two instrument limits, both stated by the authors of the instruments, unprompted:**
- **The startup line does NOT distinguish a stale binary from an unset variable** — both print
  `NOT CONFIGURED`, because a binary predating the wiring has no delivery code to report on. **Recipe:
  REBUILD, THEN READ THE LINE, in that order.** *The line answers "which world is this binary in", never "is
  this binary current."* **That is the exact failure that cost the last hour, named as a limit of the
  instrument built to prevent it.**
- **Running `dist/main.js` — which only defines `main()` and exits silently — instead of `dist/index.js`.**
  **Running the wrong artifact produced silence that looked exactly like a result**, one step from *"the
  built binary produces no boot log."*

**An instrument shipped with its blind spot stated is worth more than one shipped as an answer.**

### 24.3 The `019` defect rescoped by its own filer — and caught by a cross-wave contradiction

**Forced by an impossibility:** W4's O1 green came from a real row — `failed_permanent`, `attemptNo 1`,
`settledAt` stamped. `failed_permanent` on attempt 1 has exactly one source: `019`'s exited-target branch
writing `session_not_live` — **the branch filed as always raising `23514`.** So **either the defect was
wrong or the green was impossible.** The filer **went and measured rather than picking.**

**Measured on one scratch DB against the full 34-file chain:**

```
MEMBER-authored   → exited target:  reserve returns null, ROW WRITTEN failed_permanent/session_not_live  WORKS
TEAMMATE-authored → exited target:  THROWS 23514 pair_shape, ZERO ROWS                                   BROKEN
```

**The discriminator is `source_work_session_id`.** Member-authored has none, so the branch writes source
null *and* all three `pair_` columns null — which **satisfies** `pair_shape`. Teammate-authored carries an
`authored_from` edge, so source is non-null while the `pair_` columns are left null — which **violates** it.
**One branch, both halves of the constraint, and only one half ever executes correctly.**

**Too broad as filed:** *"every wake aimed at an exited or failed session returns an invariant violation"*
is **false**. **Too mild as filed:** the broken half is the **worse** half — **Teammate-to-Teammate is the
only path B2 exists to govern.** A Member can always get a record of a dead target; **a Teammate never
can.** And `w2_delivery_fallback` sits **below** the raise, so **the fallback written to catch an
undeliverable Teammate message is unreachable for the entire class it was written for.**

**W4's O1 green is sound and does not weaken on repair:** its Member-authored send rode the branch **working
as designed**, not the defect. The earlier warning-off of exited-target triggers was **retracted directly to
W4**; the trigger is legitimate and durable.

**Why the filing was wrong, which is the generalising part: THE CAUSATION TEST WAS ALWAYS CORRECT.** It used
a Teammate-authored message, so red/repair/green/revert/red held on 34 files throughout. **The PROSE
over-generalised from a SOUND TEST — the scenario that was run got described as the whole class.** Its filer
names it as the empty-grep shape: **it did not ask what the case it had not run would do.**

> **A SOUND MEASUREMENT DESCRIBED IN LANGUAGE WIDER THAN THE MEASUREMENT.** The day's dominant failure in
> its purest form — and **without W4's row, the over-broad scope ships.**

**The detection mechanism is itself the finding, and it is the argument for the two-wave topology:**
**two waves' outputs contradicting each other caught an error neither wave could have caught alone.**
Corroboration's useful inverse — **disagreement between independently-produced results is a detector, and it
exists only if the results were produced independently.**

### 24.4 The last finding, and it is about this document

**W4's closing correction, promoted to §0 of the close document rather than left in a message.** It had
written that the greens were artifacts of an afternoon while the *organisation* was what transfers. **The
inverse is true:**

> **THE ARTIFACTS TRANSFER AND THE SKEPTICISM DOES NOT.** A document can record that fourteen coordinator
> figures fell to workers opening files; **it cannot cause it.** And the specific hazard is that **the next
> reader inherits our conclusions WITH MORE AUTHORITY THAN WE HELD THEM WITH** — ours came with arguments
> attached and someone available to disagree; theirs arrives as a document. **Every figure that fell today
> fell while sitting in a document looking settled.**

That is why every limit in the handoff is stated **inline, beside the claim it qualifies**, instead of
trusting a later reader to re-derive it — **and it applies to the handoff itself.**

**Demonstrated in the same message, in its author's own file:** the CLI handoff's header still read
`chain at close 32 / f7a9e137f01226f3`, from before `036` and `037` landed. **A stale figure in the first
six lines of the document whose entire subject is stale figures.** Reported rather than quietly fixed —
*"because that is the whole method and it should be the last thing on the record as well as the first."*

**The countermeasure worked prospectively in the one place it mattered most.** `PROGRAM-CLOSE.md`
carries **no chain digest at all**: the closure wave argued the full-program coordinator out of printing
one, on the ground that a digest in an entry-point document is stale on the day someone reads it and that
*an announcement supplies a trigger, not a value.* **That argument is the only reason the same defect is
absent from the program's front door.** Audited at close: zero stale digests, zero stale counts.

---

**PROGRAM CLOSED.** Chain 34 / `a799b7ef1b20a9b0`. Both waves stood down with nothing in flight, no open
tasks, and **no git run by anyone at any point.** Entry point: `docs/history/program-w0-w5/PROGRAM-CLOSE.md`.
