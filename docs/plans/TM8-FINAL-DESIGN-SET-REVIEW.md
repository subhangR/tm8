# tm8 Final Design Set — Independent Final Review

**W0 closure status (2026-07-26):** B1, B2, M1–M7, and m1–m13 are closed by the adopted dossier and canonical edits indexed in §7 below. The historical CONDITIONAL APPROVE verdict is retained as review evidence, not current unresolved state. Fresh Claude Opus G0 review remains required.  

**Verdict:** **CONDITIONAL APPROVE** — 2 blockers · 7 majors · 13 minors · 0 redesigns required
**Reviewer:** independent design review session `sess_1785031786121_6yqgc4hf6` (fresh context, design-only)
**Date:** 2026-07-26
**Scope:** `TM8-FINAL-DESIGN-SET.md` and every canonical document it indexes, plus source verification against `packages/contract`, `packages/server`, `packages/cli` and `db/migrations`
**Authority:** none. No file in the design set was edited; no code was written. AM-5 holds.

---

## 0. Summary

The design set is coherent, and its binding rulings hold everywhere I checked. Every load-bearing numeric claim I could verify against source is **exactly correct** — the 81-operation catalog, the 79/2 and 80/1 splits, the 28 implemented handlers, the 43-table baseline, and the Round-12 disposition. That is unusual and it earns the set real credit.

The two blockers are not conceptual weaknesses. They are the same structural failure twice: **RULING M ("message-first") is asserted in prose but has no enforcing mechanism at the boundary where it matters.** One is a live, shipped, unrestricted HTTP binding that bypasses the entire message model; the other is a rate breaker scoped to a path agents will not use. Both are fixable with a normative paragraph plus a conformance case. Neither requires redesign.

The majors share a single root cause worth naming plainly: **no review round has ever taken the indexed set as one artifact.** Round 12's declared scope is `§0 RULINGS K/L/M · §2.2 · §5.2b/§5.2c · §5.8 · §8.1 · §9/§10 deltas only` (`WORKSPACE-LAYOUT-REVIEW.md:1010`) — the workspace spec's own delta wording. Rounds 1–11 predate K/L/M. The companion documents were closed individually, against their own scopes. So the seams *between* companions — a type in the harness doc that reopens a closed ruling, a core kind admitted in one document and absent from another's total registry, an owning document that carries none of the delta it is indexed to own — were never in anyone's scope. `TM8-FINAL-DESIGN-SET.md:136` gate 9 is the first gate whose scope is the whole set. This review is that gate, and these are its residuals.

A second, quieter theme runs through M5–M6 and m12–m13: **the corpus's summaries are consistently more confident than the documents they summarize.** The ledger indexed as "GO evidence" opens with `Verdict: NO-GO` against a superseded draft; "rounds 1–8 fully resolved" rests on a successor-finding convention nobody wrote down; and the ledger describes unbuilt locking, counter recompute and scratch containment in the present indicative — the exact confusion `TM8-FINAL-DESIGN-SET.md:7` was written to prevent. None of this is dishonest and none of it changes a design decision. But this set will be handed to implementers who read summaries first, and its summaries currently overstate.

---

## 1. Blockers

### B1 — `execution.prompt` is called an internal seam, but is a public, implemented, unrestricted binding that bypasses message-first

Four documents assert this operation is internal and has no public surface:

| Claim | Location |
|---|---|
| "The **public** `execution.prompt` surface is **superseded** by message-first communication" | `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:316` |
| "remains a transitional governed internal delivery seam" | `TM8-API-CATALOG-GROUPED-GUIDE.md:349` |
| "The public `execution.prompt` operation has no CLI command… transitional catalog/internal seam" | `TM8-SESSION-COMMUNICATION-MODEL.md:273` |
| "no CLI exposure; retained as a transitional governed delivery seam" | `TM8-CLI-GRAMMAR-REDESIGN.md:1038` |

Nothing in the design set narrows the operation itself. Verified against source:

- it is a `v1` catalog row bound to `POST /v2/entities/:id/commands/prompt` (`packages/contract/src/catalog.ts`; `TM8-API-CATALOG-GROUPED-GUIDE.md:278`);
- it is **one of the 28 shipped handlers** — `packages/server/src/facade/execution-handlers.ts:580` registers it with ordinary `claimsFor(owner, ctx, envelope)`, identical to `execution.spawn` and `execution.terminate`. There is no internal-principal check, no deprecation gate, no `501`.

**Failure scenario.** A Teammate holds an agent bearer token (Teammate-scoped per `packages/server/src/identity/service.ts:245-271`). It calls `POST /v2/entities/{sessionId}/commands/prompt` directly instead of `tm8 message send`. Text is written into the target session's PTY with **no** durable message row, **no** `authored_from` provenance, **no** `session_message_deliveries` record, **no** fallback notification, **no** wake budget, and **no** Chat feed membership. Every downstream truthfulness guarantee — `TM8-CHAT-UI-AND-LAYOUT-DESIGN.md:32` ("Graph state is canonical Chat state"), harness invariant 6 "Durable before live" (`TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md:62`), and RULING M itself — is silently false for that message. Removing the CLI verb does not close an HTTP binding.

The harness document already knows this is unresolved: `§22` item 5 (`:1471`) still asks reviewers to "reconcile public-message-first routing with the retained internal `execution.prompt` operation."

**Correction (normative, one paragraph + one test).** In `TM8-SESSION-COMMUNICATION-MODEL.md` §8.3 and `TM8-API-CATALOG-GROUPED-GUIDE.md` §16, state that `execution.prompt` is authorized **only** to the Server-internal delivery-adapter principal (the same narrowly-scoped audited principal §8.2 already defines for `session_message_deliveries`), and returns `forbidden` with `details.reason='use_message_send'` for any Member or Teammate caller. Add to SCM §14 and CLI §10: *a Teammate bearer token calling `execution.prompt` is refused and writes no PTY bytes.* Do **not** reclassify it `reserved` — that changes the frozen 79/2 split.

---

### B2 — The automated-wake breaker covers only the reply path; agent↔agent live delivery is unbounded

`TM8-SESSION-COMMUNICATION-MODEL.md:355` claims: *"Even explicit live wakes are bounded: per thread root and unordered source/target session pair, at most four consecutive Teammate-authored live wakes are allowed."*

Every wake-budget reference in the set is scoped to the reply path — `SCM:350,355,360-371`, `CLI:837,1094`, acceptance case 26 (`SCM:463`) tests only *"An A↔B agent reply chain"*. Meanwhile `SCM` §8.1 (`:225-229`) is unconditional: *"After a work-session-anchored message commits: live and delivery-capable target: attempt direct delivery."* No budget. No cap. No mention.

**Failure scenario.** Teammate A: `tm8 message send --to <B-session> "…"` → delivered to B's PTY. Teammate B: `tm8 message send --to <A-session> "…"` → delivered to A's PTY. Repeat. Neither is a reply, so `session_wake_budgets` is never consulted. Even if it were, the primary key is `(thread_root_message_id, low_work_session_id, high_work_session_id)` (`SCM:360-369`) — **each new top-level send is its own thread root**, so it would draw a fresh budget of 4 every time. The breaker cannot engage on the path agents will actually take. Two coordinator/worker sessions can burn tokens against each other until a human notices.

**Correction.** Drop `thread_root_message_id` from the budget key (or add a second per-pair budget keyed on the unordered session pair alone), and move the check from §10's opt-in wake into the delivery *reservation* in §8.1, so it applies to **every** Teammate-authored live delivery regardless of whether it is a reply. Update `SCM:355` to say so, amend `SCM` amendment 13 (`:424`) and `CLI` amendment 17 (`:1094`), and add acceptance case: *A and B exchange `message send` with no replies; the breaker engages and further attempts record `failed_permanent`/`automated_wake_limit` and fall back to inbox.*

---

## 2. Majors

### M1 — `interaction_profile` is admitted as a core entity kind but has no §2.1 registry row, violating the ruled exhaustiveness invariant

`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:64`: *"an exhaustiveness test asserts a row exists for every member of `CoreEntityKindSchema`."* RULING L (`:22`) and §8.1 (`:320`) admit `interaction_profile` as a restricted core entity kind — a classification Round 12 M12-1 specifically fought to establish (`WORKSPACE-LAYOUT-REVIEW.md:1023`).

The §2.1 table (`:67-74`) has no row for it. Nor does:

- **§5.7 share-projection registry** (`:228`) — also "total over kinds" with an exhaustiveness test against `CoreEntityKindSchema`. Undecided: does a profile fall to the generic fallback, or is it non-shareable? Handing an agent a rendered Interaction Profile via drag-to-session is a policy-disclosure question, not a formatting one.
- **§2.3 `KindRef`** (`:114`) — collection-strategy rows only; no ruling on menu-addressability.
- **§7.4-style capability matrix** — no statement that content-edit is OFF (lifecycle commands own it) or delete is OFF (retire is the verb).
- **§8's migration list** (`:310`) — names "ONE additive migration (`entity_kinds` row…)", singular, for `project` only.

`project` received all of this treatment. `interaction_profile` received none, because it arrived after the §2.1 work closed. At implementation the exhaustiveness test fails on day one.

**Correction.** Add a §2.1 row (`Interaction Profiles` / `interaction_profile` / slug `interaction-profiles` / strategy `collection`, registered but not in the default menu — exactly the spells/skills pattern at `:70`), a §5.7 projection disposition, a §7.4-parallel capability line, and a second `entity_kinds` row in §8's migration.

### M2 — `DOMAIN-ARCHITECTURE-DECISIONS.md`, the set's designated owner of "Domain, entities and tables", carries none of RULING K/L

`TM8-FINAL-DESIGN-SET.md:75` assigns this document the "Grouped domain model, 43-table implemented baseline and amendment map." It discharges the first two. It does not discharge the third for K/L:

| Section | What is missing |
|---|---|
| §5.1 core kinds (`:300-305`) | `interaction_profile` absent; only `project` named as the amendment's addition |
| §5.2 relations (`:313-317`) | `defaults_to_profile`, `selected_profile`, `authored_from`, `participates_in`, message-owned `attached_to` all absent |
| §6.2 additive storage (`:344-361`) | `interaction_profiles`, `work_session_interaction_pins`, `work_session_view_preferences`, `session_message_deliveries`, `session_wake_budgets`, message-batch correlation, `notifications.recipient_team_member_id` all absent |
| §7.2 API groups (`:390-403`) | `interactionProfiles.*` and `entities.feed` absent |
| §8 current-vs-target (`:427-436`) | Chat, profiles and templates absent entirely |

Only the subordination note (`:9`) acknowledges I–M exist. Meanwhile §9 (`:446-516`) publishes scores — Domain 9.2, Entities/tables 8.8, APIs 8.7, Overall 9.0 — computed against a model that predates the delta. A reader following the index to the owning document for tables gets a confidently-worded, materially incomplete answer.

**Correction.** Either extend §5.1/§5.2/§6.2/§7.2/§8 with the K/L delta and re-derive §9, or amend `TM8-FINAL-DESIGN-SET.md:75` to scope this document to the v2.10 baseline and point "entities and tables" at `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` §8.1 + `TM8-CURRENT-BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md` §11.4–§11.6. The first is better; the second is honest.

### M3 — The harness doc's `FeedPolicy` type reopens the unversioned predicate list that RULING K closed

`TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md:163-168`:

```ts
type FeedPolicy = {
  include: Array<"subject" | "anchored" | "authored" | "replies" | "caused">;
  pageSize: number;
  bodyExcerptBytes: number;
};
```

Against `TM8-CURRENT-BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md:207`: *"An Interaction Profile pins the named scope, **not an unversioned implicit list**."* And RULING K (`WORKSPACE…:22`): Chat is populated *"via `entities.feed` scope `session_chat_v1`."* And `TM8-FINAL-DESIGN-SET.md:37`.

This is not cosmetic. `FeedPolicy` is a field of `ResolvedInteractionProfilePin` (`:131`) — the *immutable runtime authority*. A validated profile could pin `["anchored"]` or `["authored","caused"]`, producing a Chat membership that no scope name describes. That defeats three closed guarantees at once: the versioned-scope contract (briefing `:207`), the cursor fingerprint bound to "resolved scope name and **exact predicate set**" (briefing `:242`), and C3's protection against a silent one-hop reinterpretation (`TM8-CHAT-UI-AND-LAYOUT-DESIGN.md:702`).

**Correction.** `type FeedPolicy = { scope: 'direct_v1' | 'session_chat_v1'; pageSize: number; bodyExcerptBytes: number }`.

### M4 — The harness document has never been adversarially closed, yet carries the most unreviewed normative material in the set

`TM8-FINAL-DESIGN-SET.md` §8 records closures for SCM (gate 1, Round-4 GO), profile lifecycle (gate 2, FINAL GO), Chat UI (gate 3, C1–C9), workspace v2.11 (gate 4), and the Round-12 delta (gate 5). **There is no gate for the harness document.** The only recorded closure touching it is "harness-owner consensus joined" on three narrow points (`WORKSPACE…:22`: transitive closure, CLI scope names, `--around` focus).

Its own status line reads "Review-ready design" (`:3`), and §22 (`:1463-1477`) still asks reviewers to decide eleven items — including #5, which B1 above shows is genuinely unresolved.

What is unreviewed and normative: the 4 KiB agent manifest schema (`§5.1`), the exact 6 KiB trusted kernel prompt text (`§5.2`), every byte budget (`§8.1`), the cache-key/invalidation matrix (`§8.2`), the worker and coordinator state machines (`§10`, `§11`), all ten injection templates (`§14`), the security/untrusted-content boundary (`§18`), and the ~50-case conformance suite (`§20`). M3 and minors m2/m3 are what one pass over it surfaced.

**Correction.** Add an explicit §8 gate: one targeted adversarial round on the harness document, or an explicit downgrade of its status in `TM8-FINAL-DESIGN-SET.md:79` from owning document to *input, budgets and kernel text pending review*, moving them into the dossier's own review scope.

### M5 — The review ledger describes unbuilt design in the indicative present, which is the exact failure `TM8-FINAL-DESIGN-SET.md` §1 exists to prevent

`TM8-FINAL-DESIGN-SET.md:7` states its own purpose: *"prevents a reader from treating a proposal as shipped behavior."* The ledger it indexes at `:74` as "Finding-by-finding ledger and **GO evidence**" repeatedly violates that, describing document edits as operative machinery:

| Line | Wording | Reality |
|---|---|---|
| `:479` | "§5.2a **now introduces** the previously missing app-lifetime `TerminalPool`, tokened host leases, DOM reparenting…" | R3-1 (`:379-385`) had just established no such code exists |
| `:569` | "Both delete and restore **now recompute** all affected live counterparts in-transaction with indexed access and sorted locks" | `:882` says that SQL is unwritten dossier work |
| `:992` | "Every `in_project` creation/promotion… **now takes** the same project-resource lock" | `in_project` is absent from the `edge_types` seed entirely |
| `:995` | "Materializer-driven projection soft-delete and restore **now inherit** R4-5's in-transaction counter recompute" | no materializer exists |
| `:996` | "**Scratch execution has** a named server-owned containment domain, generated session path, private permissions…" | not implemented |
| `:1032` | "**The lease survives** mode switches, **`markWarm` fires** on Terminal re-selection after Chat… **This is the concrete mechanism** behind the first-class-Terminal invariant" | describes an unbuilt mechanism as operative |
| `:1017` | "All eleven product invariants **verified holding at first read**" | verified against document prose, not a running system |
| `:921` | "G2 also **correctly removes** work-session rows from the materialized-edge repair regime" | a doc edit described as a regime change |

The ledger itself elsewhere states no build exists (`:328`, `:243`). This matters because the ledger is cited as *evidence*: a reader — or an implementer — sampling these lines will conclude that locking, counter recompute and scratch containment are in place. Round 12's own m12-2 (`:1025`) found the same class of drift inside the spec.

**Correction.** Sweep the ledger for indicative-present verbs describing unbuilt mechanisms and restate them as what they are ("§5.2a **now specifies**…", "the spec **now requires** that both delete and restore recompute…"). Add one line under the ledger's masthead: *this document records design dispositions; no statement here asserts implemented behavior.*

### M6 — "Rounds 1–8 fully resolved" has no per-finding evidence; twenty finding IDs are last recorded as PARTIAL

`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:3` asserts *"rounds 1–8 fully resolved"*, and `TM8-FINAL-DESIGN-SET.md:74` indexes the ledger as the evidence. The ledger never upgrades twenty IDs from PARTIAL: F4, F10, F12, F14, F15, F17 (`:230,236,238,240,241,243`); R2-2, R2-4, R2-5, R2-7, R2-10 (`:365,367,368,370,373`); R5-1, R5-3, R5-6 (`:661,663,666`); R6-1, R6-3, R6-5 (`:830,832,834`); R7-1, R7-3, R7-8 (`:819,821,826`). Only five PARTIALs are ever explicitly upgraded (`:575-577`, `:831`, `:833`).

Round 9 — the round that issues the FINAL GO — audits **only R8-1..R8-5** (`:896`, heading `:900`). It re-audits none of the twenty.

In fairness, the ledger's working convention is that a PARTIAL's residue is re-issued as a new numbered finding (F4 → R2-1/R2-3/R2-4; R6-1 → R8-4/R8-5) and the successors *do* close. I believe the substantive claim is defensible. But **that successor chain is nowhere written down**, so "fully resolved" currently rests on a convention a reader must infer, and each round header's "0 UNRESOLVED" means "nothing wholly unaddressed", not "everything closed".

**Correction.** Add a traceability table to the ledger: `PARTIAL id → successor finding id(s) → closing round`. This is bookkeeping, not rework, and it converts an inferred claim into evidence. Until it exists, `WORKSPACE…:3` should read "rounds 1–8 closed, residues carried forward as numbered successors."

### M7 — No round has ever reviewed the indexed set as one artifact

Stated in §0 above; recorded here as a finding because it explains B1–B2 and M1–M4 and should shape what happens next. Round 12's scope line is explicit (`WORKSPACE-LAYOUT-REVIEW.md:1010`). Every finding in this review lives in a seam between two separately-closed documents. The correction is procedural: record this review as gate 9 with its residuals, and require the §8 dossier to carry a cross-document consistency matrix (kind registry × route strategy × projection renderer × capability matrix × menu eligibility × migration row) rather than prose in five places.

---

## 3. Minors

| # | Finding | Evidence | Correction |
|---|---|---|---|
| m1 | **`§8.2` is a dangling reference.** Cited as the authority for the persisted `default_channel_id` four times; no such heading exists (headings run §8 → §8.1 → §9). Home → Feed points at nothing. | `WORKSPACE…:32`, `:148`, `:310`; `DOMAIN…:236` | Promote the default-channel clause out of §8's prose into a real §8.2. |
| m2 | **Wrong credential env var.** Manifest declares `bearerEnv: "TM8_AUTH_TOKEN"`; the shipped CLI reads `TM8_AGENT_TOKEN`, and the briefing cites it correctly. An agent bootstrapping from the manifest looks up the wrong variable. | harness `:231` vs `packages/cli/src/env.ts:29`, `packages/cli/src/run.ts:39`, briefing `:102` | Use `TM8_AGENT_TOKEN`, or declare the rename as an explicit §17 amendment. |
| m3 | **Retired grammar in harness examples.** `tm8 message send --anchor <entityId> … [--reply-to <messageId>]` — canonical grammar is repeatable `--to` with a separate `message reply` verb. | harness `:435`, `:444` vs `CLI:418,425,465` | Fix both examples. |
| m4 | **`scope=default` exists in exactly one document.** The briefing defines `scope=default\|direct_v1\|session_chat_v1` with kind-based resolution; three other documents state the operation exposes only the two versioned names. | briefing `:193-207` vs `TM8-FINAL-DESIGN-SET.md:37`, `WORKSPACE…:317`, C1 (`CHAT-UI:700`) | Add `default` to the three, or drop it. Either way state it is **never pinnable by a profile** — otherwise it is the unversioned implicit list §11.1 forbids. |
| m5 | **Proposed storage presented in implemented voice.** §4's cardinality table and §2's diagram cite `project_links`, `in_project` and `launchProjectId` in the same declarative register as §6.1's genuinely-verified 43-table baseline. Verified: `project_links` absent from all migrations; `in_project` absent from the `edge_types` seed; `launchProjectId` zero hits repo-wide. Also **`work_sessions.project_id` immutability has no DB enforcement** — no trigger, no check; it is unreachable only because no RPC writes it after `007_rpc_catalog.sql:2089`. | `DOMAIN…:101`, `:280-282`, `:330`; `db/migrations/001_core_graph.sql:698,900-929` | Mark those rows proposed; correct "immutable" to "immutable by write-path construction; the dossier must add the trigger." |
| m6 | **Section ordering.** `## 19. Round-10 map` sits between §15 and §16. | `WORKSPACE…:375` | Reorder. |
| m7 | **An agent can pin a Project link open.** `in_project` from a work_session is agent-writable (G2), and G5 refuses `projects.unlink` while any live session holds one. An agent can associate every linked projection and block an admin's unlink until the admin deletes each edge. | `WORKSPACE…:292`, `:297` | Recoverable (admin edge-delete is the repair) — state that remedy explicitly and add a per-session association cap. |
| m8 | **Cross-session contact authorization is explicitly undefined**, and is not a §8 gate. "The final carrier must distinguish ordinary `canMessage`, session contact, and entity-handoff authorization." Given B1 and B2, this is the load-bearing missing permission. | `CLI:864` | Promote to an explicit dossier gate; define the three capabilities before the delivery machine is built. |
| m9 | **SCM records "Round-4 GO (0B/0M)" while carrying 10 open review questions.** Q1 (`participates_in` name/direction), Q2 (Member as participant endpoint), Q5 (RPC vs role for the execution principal) and Q8 (amended `messages.post` vs new `messages.postMany`) are design decisions, not measurements. | `SCM:467-479`; gate 1 at `TM8-FINAL-DESIGN-SET.md:128` | Classify each of the ten as design-open or prototype-gated rather than folding all under "GO". |
| m10 | **`message_batch` ambiguity.** Drawn as a storage node in §3.2; amendment 3 implies only a correlation column. | `SCM:66` vs `:414` | Say which. |
| m11 | **Message read authorization vs anchor is unstated.** `session_chat_v1.authored` admits every message authored from the session regardless of anchor. Safe today only because visibility is inert — and CLI amendment 24 contemplates making `Visibility` writable. | briefing `:203`; `SCM:125`; `CLI:1106` | State now that a message's read authorization derives from its anchor, so `authored`/`replies` cannot leak anchor-restricted messages into a session Chat feed once visibility becomes real. |
| m12 | **The review ledger's masthead still reads NO-GO.** Lines 3–5 are the unmodified Round-1 header — "Review target: … (**DRAFT, 2026-07-25**)", "**Verdict: NO-GO**", "5 BLOCKER · 14 MAJOR · 1 MINOR" — with no `# Round 1` heading and no supersession note. Anyone opening the document indexed as "GO evidence" reads NO-GO against a superseded draft. | `WORKSPACE-LAYOUT-REVIEW.md:3-5` | Add a `# Round 1` heading and a current-status masthead above it. |
| m13 | **Stale finality labels and an unsurfaced regression.** `:892` "# Round 9 (final)" and `:910` "design ledger closed" are falsified by Rounds 10–12 that follow in the same file. The trajectory is also non-monotonic — CONDITIONAL GO at Rounds 4 and 5, then **NO-GO at Round 6** (`:655`) on new blocker R6-1 (`:672`) — which the spec header presents as an unbroken march. Separately, "Round-11 micro-verification" (`WORKSPACE…:3`) borrows a term from the *profile-lifecycle* closure; Round 11 is a full six-finding delta audit (`:984-990`), not a micro-pass. | `WORKSPACE-LAYOUT-REVIEW.md:655,672,892,910`; `WORKSPACE…:3` | Re-label Round 9 "final for the original design ledger"; drop "micro-" from the Round-11 description. |

---

## 4. Verified correct — recorded so it is not re-litigated

Everything below was recounted from source, not trusted from a header.

- **81 operations, exactly.** `packages/contract/src/catalog.ts` `OPERATIONS` (lines 30–142): 81 total, 79 `v1`, 2 `reserved` (`search.query` `:95`, `bridge.fetchBlob` `:111`), 1 `WS` (`events.subscribe` `:128`) + 80 HTTP. No duplicate names. The claims at `TM8-FINAL-DESIGN-SET.md:86` and `TM8-API-CATALOG-GROUPED-GUIDE.md:5` are exact.
- **The grouped guide is a perfect bijection with the catalog.** Its §2 summary sums to 81; every section header count matches its own row count; every summary count matches its section. Diffing operation ids *and* `name|METHOD path` triples: zero in guide-not-catalog, zero in catalog-not-guide, zero method or path drift. §18's proposed operations are correctly excluded.
- **28 implemented handlers, exactly.** `facade/index.ts:86-125` (23) + `facade/execution-handlers.ts` (4) + `events/handlers.ts:87` (1). Corroborated by `STATE.md:214` and the `/health` payload. Worth one clarifying sentence in the dossier: the true handler ceiling is **78** (81 − 1 WS − 2 reserved, which `facade/registry.ts:43-48` refuses to register); 80 is the mounted-route count; 81 is the catalog. All three numbers appear in the corpus meaning different things.
- **43 tables, exactly.** 43 `CREATE TABLE` across `001`–`006`, zero `DROP TABLE`, zero `RENAME`. `DOMAIN…§6.1`'s seven groups name exactly that set — zero drift in either direction. (A migrated database has 44 physical tables; `applied_migrations` is created by `db/migrate.mjs:142`, not by a migration.)
- **Round 12 is as claimed, within its declared scope.** `WORKSPACE-LAYOUT-REVIEW.md:1011-1013`: CONDITIONAL GO (0 blockers · 1 major · 3 minors) → **4 RESOLVED · 0 PARTIAL · 0 UNRESOLVED** → GO, no residuals. I independently confirmed all four repairs exist in the spec (`:22` entity-kind classifier, `:21-22` ruling order, `:137` two-mode wording matching `:332`, `:15` forward pointer to K). M12-1's diagnosis — that "config-class" had bound to the nearer noun and belonged to the static template registry, not the profile — is correct and well-argued. Three caveats the "4/4, no residuals" phrasing hides, and which the adoption record should carry: the findings were raised **and** closed inside the same round ("Disposition after repair cut", `:1012`), unlike Rounds 2–9 where the *next* round audited the previous round's fixes; the reviewer (`:1009`) is not the Rounds 1–9 adversary; and the scope (`:1010`) re-audits nothing from Rounds 1–11.
- **Every binding ruling holds.** Server as root noun; Space as the collaboration/authorization/event boundary; Workspace as UI only; ProjectResource + per-`(space, ProjectResource)` projection via `project_links`; M:N `work_session` projects with `in_project` as authority and immutable `launchProjectId` as provenance only; Terminal as a complete first-class native PTY that no profile may remove, demote or gate, never split with Chat; Chat as an optional peer; one graph message store with Chat and Discussion as projections; `providerCaptureMode='explicit-only'`; static templates as registry assets with no entity, API or CLI noun; `interaction_profile` as a restricted entity with an immutable session pin as sole runtime authority; `session_chat_v1` as the exact transitive descendant closure with `root_message_id` as prefilter only; no code written; AM-5 intact.
- **The CLI grammar's 81-row disposition is honest and complete**, and — rarer — it accounts for *both* directions: every frozen row has a disposition, and every proposed command or flag is separately tabulated as amendment-dependent (`CLI:1049-1071`).
- **The Chat UI document is the strongest artifact in the set.** Its state enumeration (`§17`), the four-layer send-state separation (`§10.4`), and the C8 "Send again, never Retry" ruling are the kind of specification that prevents a class of bugs rather than describing one.
- **Phase 2 is honestly deferred** and does not contaminate the local model. Its own 8.2/10 self-assessment with an explicit "not implementation-ready" is the correct posture.

---

## 5. Is this design coherent and implementation-dossier-ready?

**Coherent: yes.** I looked specifically for a load-bearing contradiction between the rulings and did not find one. Terminal-vs-Chat, the resource/projection split, the M:N-with-immutable-provenance model, the one-message-store rule, and the pin-as-runtime-authority pattern all compose. The `launchProjectId` pattern being deliberately reused for `work_session_interaction_pins` is a genuinely good piece of architecture — the same shape solving the same problem twice is how a domain earns its vocabulary.

**Dossier-ready: yes, conditionally.** Both blockers are single-paragraph normative fixes plus conformance cases, not redesigns. M1–M3 are mechanical completions of work already ruled. M4–M5 are procedural. Nothing here requires reopening a closed ruling or reversing a user decision.

**Its real risk is the one §9.5 of the domain doc already names: specification density.** ~7,200 lines across ten documents, with authority distributed by topic and cross-referenced by section number. Every finding above is a density failure, not a thinking failure — a type that contradicts a ruling four documents away, a kind admitted here and absent there, a section number cited four times that does not exist. The dossier should carry consistency *matrices*, not more prose.

### Remaining adoption/prototype gates — **not** design defects

These are correctly deferred and should not be counted against the design: the Workspace reference capture and measured §5.6 breakpoints; the browser/OS keyboard receive matrix; prototype validation of the 32,768-byte share-projection cap; measured message batch/attachment/aggregate limits; the measured pending-delivery TTL; the per-agent-tool receiver feasibility matrix; Vega's adoption and the T-D20/R17 reversal logged in the master corpus; authoring and approving the §8 dossier itself; and AM-5.

### Scores

| Area | Score | Rationale |
|---|---:|---|
| Domain model & ubiquitous language | **9.0** | Every noun has one job. Single-homing, the resource/projection split, and Remote-as-adjective are all right. Loses points only for the corpus-wide terminology pass still being pending. |
| Entities & tables | **8.0** | Baseline verified exact. The K/L storage delta has no owning document (M2) and one admitted core kind is missing from the total registry (M1). |
| API design & frozen boundary | **8.5** | Perfect catalog↔guide bijection, honest 501s, clean frozen-vs-proposed separation. B1 is a hole in that boundary, not in the design of it. |
| CLI grammar & ergonomics | **9.0** | Best-executed artifact in the set. Regular, discoverable, 81/81 honest, both amendment directions accounted, laws (output/exit/idempotency/confirmation) composable. |
| Messaging, delivery, feed, inbox | **7.5** | The model is right — stored-first, delivery as a facet, one inbox, at-most-once honesty. B2 plus undefined cross-session contact authorization (m8) plus ten open questions under a "GO" (m9). |
| UI, layout & Chat | **9.2** | Closed, exhaustively stated, truthful about what a bubble means. |
| Harness, discovery & orchestration | **7.0** | Excellent instincts — bounded budgets, progressive disclosure, trusted/untrusted separation. Never adversarially closed (M4), and one pass found a ruling reopened by a type (M3) plus two stale artifacts. |
| Security & authorization | **6.5** | The lowest score, and deliberately so: B1, B2 and m8 are all authorization. The *stated* posture (untrusted delimiters, profiles narrow-never-grant, server-side re-authorization, secrets never serialized) is strong. The enforced posture at the live-delivery boundary is not yet specified. |
| Remote / Phase 2 | **8.5** | Correctly scoped, correctly deferred, zero local contamination. |
| **Overall** | **8.2** | A strong, unusually rigorous design set with two enforcement gaps and a distribution problem. |

---

## 6. Recommended sequencing

1. Fix B1 and B2 in `TM8-SESSION-COMMUNICATION-MODEL.md` (+ mirrored one-liners in the API guide and CLI doc) with their conformance cases. These are the only two items that block dossier authoring.
2. Fix M1 (§2.1 row + projection + capability + migration row) and M3 (`FeedPolicy` type) — mechanical.
3. Resolve M2 by choosing: extend the domain document, or narrow its index role in `TM8-FINAL-DESIGN-SET.md:75`.
4. Resolve M4 by choosing: one adversarial round on the harness document, or an explicit status downgrade + a new §8 gate.
5. Repair the ledger (M5 verb sweep, M6 traceability table, m12 masthead, m13 labels). Bookkeeping only, but it is what the dossier's authors and the implementers will read as evidence.
6. Sweep the remaining minors; m1, m2 and m4 are each a one-line edit.
7. Record this review as gate 9 with its residuals, then proceed to Vega adoption and dossier authoring.

No implementation is authorized by this review. AM-5 continues to hold.

---

## 7. W0 closure disposition

This section records documentary closure of the historical findings; it does not revise the evidence that originally produced them and does not claim implementation.

| ID | Disposition | Exact closure authority |
|---|---|---|
| B1 | **CLOSED** | `TM8-W0-AMENDMENT-DOSSIER.md` §§5.1, 10; SCM §§8.2–8.3 and acceptance 30; API §16/§18; CLI §§5.5/8/9; harness M11; T-D23. |
| B2 | **CLOSED** | Dossier §§5.2, 8.2–8.3; SCM §10 and acceptance 26/29; CLI amendment 17; harness §§12, 16 and M10. |
| M1 | **CLOSED** | Workspace §2.1/§7.6/§8; dossier §6.4; consistency matrix §2. |
| M2 | **CLOSED** | DOMAIN D16/D17, §§4–8 now own K/L kinds, relations, storage, operations, and current/target posture. |
| M3 | **CLOSED** | Harness `FeedPolicy.scope`; dossier §6.3. |
| M4 | **CLOSED** | Harness §22 records the independent adversarial pass and adds M10/M11/M12/S6. |
| M5 | **CLOSED** | Workspace ledger masthead disclaimer plus documentary-verb sweep. |
| M6 | **CLOSED** | Workspace ledger `PARTIAL finding traceability` table contains all 20 IDs and successor chains. |
| M7 | **CLOSED** | `TM8-W0-CONSISTENCY-MATRICES.md` is total over kinds and 81+20 operations; G0 reviews the indexed set. |
| m1 | **CLOSED** | Workspace real §8.2. |
| m2 | **CLOSED** | Harness manifest `TM8_AGENT_TOKEN`. |
| m3 | **CLOSED** | Harness `--to` plus separate `message reply`. |
| m4 | **CLOSED** | Workspace/API/UI/briefing/dossier align on request-only `default`, concrete echo, never pinnable. |
| m5 | **CLOSED** | DOMAIN labels proposal rows and dossier freezes the `project_id` immutability trigger. |
| m6 | **CLOSED** | Workspace round maps ordered 16→17→18→19. |
| m7 | **CLOSED** | 16 live session associations plus owner/admin ordinary-edge deletion repair. |
| m8 | **CLOSED** | Dossier §5.3 and SCM/CLI capability boundaries. |
| m9 | **CLOSED** | SCM §15 classifies all ten former questions. |
| m10 | **CLOSED** | Dossier §6.1 and SCM §3.2: nullable correlation only, no entity/table. |
| m11 | **CLOSED** | Briefing §11.1, DOMAIN §5.3, workspace §8.1, dossier §§6.3/8.4. |
| m12 | **CLOSED** | Ledger current masthead, disclaimer, and `# Round 1`. |
| m13 | **CLOSED** | Round 9 label is limited to original ledger; Round 11 is delta-final; masthead exposes non-monotonic Round-6 NO-GO. |

Source-backed count closure is explicit: 81 catalog rows = 79 v1 + 2 reserved; 80 mounted HTTP routes + one WS; 78 registerable HTTP-handler ceiling; 28 currently wired semantic HTTP handlers; 43 product migration tables. The adopted twenty-operation target remains documentary until W1 changes source.
