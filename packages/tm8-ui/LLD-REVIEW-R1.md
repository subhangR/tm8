# LLD Adversarial Review — Round 1 (reviewer of record)

**Target:** `packages/tm8-ui/LLD.md` (584 lines, uncommitted working tree, as reviewed 2026-07-28).
**Reviewer:** LLD Adversary (Fable-5), sess_1785185045389_pmu4tgg56, task task_1785185030486_2my2voihe.
**Verdict:** **REJECT** — 5 MAJOR / 4 MINOR / 0 BLOCKER. Per charter R5 this review gates Phase 2; iteration to APPROVE is underway with the LLD author (sess_1785178112973_u7gfr8aim).
**Authority chain judged against:** charter R1–R15 → `packages/tm8-ui/DECISIONS.md` (D1–D8 as read; a D9 landed after review and enters Round-2 scope) → WLT v2.11 (08-SPECS copy; verified byte-identical to the docs/plans copy) → TM8-UI-SPEC-FINAL → 01/02/03 requirement docs → canvases (D4 canonical set). Seam consensus object: `packages/tm8-ui/src/data/LLD.md` §4 (stamped 2026-07-28).
**Transmission note:** findings were delivered to the author as `[adv->lld 2]` (a corrected RESEND after `[adv->lld 1]` was corrupted by shell backtick substitution in transit; caught via R15 unsuppressed-stderr discipline). This file is the durable copy of the same findings, verbatim in substance.

## What held under attack (do not relitigate)

Condemned-code hygiene is clean (`buildHash` router.ts:170-187 condemned + never harvested; CenterPane k=4, TaskPanel/ResourcePanel markup, tm8Kinds copy, whole-window pixel oracle all condemned; CI grep specified). C_min table exact (320/320/648/976/1304). All 15 `CoreEntityKindSchema` kinds match schemas.ts:79-83. Every §14 harvest path verified to exist with matching LOC (nav.ts 228, EntityPanel.tsx 427, VirtualList.tsx 187, SessionTerminal.tsx 512, RealFacade.ts 539, pty-protocol golden-frames test + fixture present). Keyboard §7 matches WLT §5.8 including retirements, exclusion list, and the escape contract. Route grammar + redirect table complete vs WLT §2.2 + SPEC-FINAL §4.2.5. Registry/no-branching design is sound — NO kind-branching defect found. D1–D4 correctly folded. Slug/reserved lists verbatim per WLT §2.1.

## Findings

### F1 (MAJOR — kind-registry/seam: a behavior with no carrying field, the LLD's own L2 defect class)

§5.4 says "dot pulses while the focused session streams"; §2.2 has `tile.pulse` over `EntitySummary`; §13 has the reduced-motion "streaming" word fallback; §10.6 fixtures include "running+streaming". NO source for "is streaming" exists anywhere in the design: `SessionLiveness` has no streaming member; the TerminalPool API (§9.2) exposes no activity/data signal; §1.1 rule 3 forbids anything outside terminal/transplant touching bytes; `EntitySummary` carries no streaming field — so `tile.pulse` over `EntitySummary` can only fake it via `activityAt` recency, which is exactly the UI-derived-liveness inference class R-UI-5 (§10.2.2) and D6 forbid.
**Fix:** name the signal and its API (e.g. the pool exposes `onActivity(sessionId)` sourced inside the transplant boundary) OR downgrade pulse to a liveness-verdict presentation; and make the fixture state's carrier explicit.
*Status note at write time: author disclosed a pre-hold partial fix (pool `onActivity(cb)`, transplant-boundary derivation, no bytes exposed, presentation gated on live `statusOf`); consumer rewiring (§2.2, §3.1, §5.4, §13, §10.6) pending — finding stays open until the full chain re-verifies.*

### F2 (MAJOR — internal contradiction on the highest-risk rule)

§2.2 defines the ListConfig field named `liveTreatment`, typed as a function taking the seam's `SessionLiveness` verdict and returning a `LiveTreatment` — correct: it PRESENTS the seam verdict. But §3.1 says the field "liveness" implements R-UI-5 ("one predicate derives the row's click target AND the live affordance"), and §10.2.2 refers to "ListConfig.liveness / needsAttentionGroup predicates (§2.2)". No field named "liveness" exists in the LLD's ListConfig. That name is SPEC-FINAL §4.5.2's SUPERSEDED signature — a predicate from `EntitySummary` to `Liveness`, i.e. the UI-derivation shape the stamped consensus killed (data LLD §9: `statusOf` is THE ONLY place liveness truth is computed). An implementer reading §3.1 alone will re-derive liveness inside config. The LLD's own §2.2 law says the acceptance matrix names fields — a named field must exist.
**Fix:** rename the prose references to `liveTreatment` everywhere, and reword §3.1 so "the one predicate" is `seam.liveness.statusOf`, with ListConfig purely presentational.

### F3 (MAJOR — seam-surface mismatch, violates the LLD's own §10.2.6 rule)

Two specified UI flows are wired to commands ABSENT from the stamped seam (`src/data/LLD.md` §4 commands run `createEntity` through `terminate` — no handoff command, no menu write): **(a)** §8 "Issue `handoffs.send` with client-generated handoffId" — the seam has only the `handoffs(workSessionId)` READ; **(b)** §4.4 SettingsView "sends MenuConfigPayload + expectedRevision" — no `spaces.menu.update` in the seam. §10.5 simultaneously claims FE consumes only cataloged ops + the two ruled deltas. §10.2.6: anything beyond the consensus list is a DUAL RE-CONSENSUS, never an FE-side addition — but neither flow is flagged as pending re-consensus.
**Fix:** mark `handoffs.send`/`withdraw` and `spaces.menu.update` (and `spaces.home` — see F4) explicitly as PENDING DUAL RE-CONSENSUS items with their phase gates, rendered disabled-with-reason via the §10.3 gate-1 mechanism until stamped.
**Coordinator ruling (fe, [fe->adv 8], binding for the fix round):** both ops stay OUT of the stamped seam; the fix is to mark both flows as deferred seam amendments requiring dual re-consensus (ruled with bridge, recorded).

### F4 (MAJOR — fixture matrix contains seam-unservable rows; one contradicts D7.2/R8)

§10.6 row "Inbox/home/presence: … HomeSnapshot with all three collections; viewers+typing". **(a)** viewers+typing: the consensus seam exposes NO presence surface at all (data LLD §12: R8 dormant, client never synthesizes; presence is measured-EMPTY on every node) — no read exists that could serve this fixture data, and rendering populated viewers contradicts D7.2's hollow-value law that the SAME matrix asserts two rows up ("presence measured-empty (hollow viewers footer)"). **(b)** HomeSnapshot: `spaces.home` is deliberately NOT in seam v1 (§10.2.7) — HomeView (§4, §14, T5-1) has no data path and no tracked re-consensus item; "HomeSnapshot with all three collections" cannot flow through the seam fixture impl, which implements the Seam 1:1 (§10.6).
**Fix:** delete or re-scope both sub-rows (presence fixtures = empty/hollow per D7.2; Home = name the `spaces.home` re-consensus as the T5-1 fan-out precondition).
**Coordinator ruling (fe, [fe->adv 8], binding for the fix round):** fixture rows must be seam-servable; viewers/typing rows drop to hollow-value rendering notes per D7.2/R8; Home data path marked capability-gated per D7.1.

### F5 (MAJOR — charter R7 completeness: "never hidden" violated by omission)

R7's deferred set is: graph canvas, UNDO / VERSION-HISTORY / HANDOFF-WITHDRAW, leaderboard/awards, saved-views/axes control, SEARCH RESULTS VIEW — all must render disabled-with-reason, never hidden, never built. The LLD homes Graph (§3.3) and Leaderboard/Activity/saved-views (§4.2 palette rows), but: no handoff-withdraw affordance anywhere (§8 renders other actors' withdrawn STATE only); no version-history affordance (the §3.2 footer `v{n}` is its natural home; nothing said); undo appears only as the row-8 "no undo" copy (the general undo feature has no disabled home); and §4.2's deferred discovery-row list ("Leaderboard, Activity, saved views, Graph") omits search-results-view.
**Fix:** give each R7 member a named disabled-with-reason home (palette discovery row and/or in-situ control), or an explicit ruling-cited rationale where no affordance surface exists.

### F6 (MINOR — authority-header staleness)

Header cites "R1–R12" — the charter is R1–R15 (R13 lossy-comms, R14 verified-quiet, R15 instrument-output; §16 process should carry them). Header cites "DECISIONS.md (D1–D4)" while the ledger is at D8+ and the LLD itself leans on D7/D8 in §10.3. Also §16 "Already binding: D1…D4, D7/D8" skips D5/D6, which bind exactly what this LLD specifies: cite D5 at the §14 canvas-literal transcription rule, and D6 at the §10.6 stale-session fixture vocabulary.

### F7 (MINOR — harvest mislabel)

§14 routes/transport row harvests "ONLY createBrowserTarget/createMemoryTarget/startRouter". `startRouter` (router.ts:121-167) is hard-coupled to the OLD nav store (`useNavStore`, `hydrateFromHash`, `toHash`, `routeKey`) — it cannot be harvested as code without dragging the superseded store; SPEC-FINAL §4.2.5 deliberately limits the transport harvest to router.ts:36-97.
**Fix:** reclassify `startRouter` as (d) fresh, with the old loop as pattern reference only.

### F8 (MINOR — stale/invented contract names)

§2.2 says "the contract's CollectionFilters/sort unions" — no exported `CollectionFilters` type exists; the shape is the anonymous `filters` object inside `CollectionQuery` (contract.ts:215-236); name it accurately. §2.1's slug comment "null for message (anchored)" — channel's slug is ALSO null/none (WLT §2.1 marks it "— (reserved word)"); the comment as written invites a wrong channel row.

### F9 (MINOR — small internal inconsistencies)

**(a)** §5.1 asserts side-panel defaults "left 280 / right 319" (correct per 02-LAYOUT-SPEC §2.1) while §16 lists "side-panel default widths within spec ranges" as a future build-time D-entry — that value is already spec-decided; drop it from the open list or restate what is actually open. **(b)** §15.7 claims the pool test list is "WLT §5.2a/c list, verbatim" but omits "releasing the active lease" (§5.2a) and the §5.2c legs (two-pinned-streaming, resize-authority-follows-activation, cold-deep-link-past-grace; Terminal→Chat→Terminal may defer to Phase 2 with a note). List them or drop "verbatim".

---

*Round 2 opens on the author's per-finding dispositions (`[lld->adv 2]`). Re-verification will run against the edited file, the tree, and the D9 ledger entry. A second independent review (replacement adversary seat) writes to `LLD-REVIEW-R1B.md`; per coordinator ruling the two accounts stay unread by each other until Round 2 closes.*

---

# Rounds 2–3 record and FINAL VERDICT (appended by the reviewer of record)

**Round 2** (LLD at 623 lines): F1–F9 all VERIFIED FIXED against the file text and the tree, including the fe-coordinator's binding F3/F4 rulings folded exactly as issued (new §10.7 dual re-consensus register; fixtures seam-servable; presence hollow per D7.2/R8; Home capability-gated per D7.1) and the ledger deltas D9 (fixtures wire-shaped, §10.6) and D10 (real-browser pixel acceptance a named R5-gate precondition, §15.8) read from the ledger file and verified folded. Verdict: REJECT on one new MAJOR introduced by the fix pass — **F10**: the §10.7 heading + register table were inserted into the middle of the §10.6 dataset matrix, orphaning its "Inbox" and "Presence / Home" rows inside the register table, which (by table membership) misfiled Inbox as a deferred seam amendment in direct contradiction of the stamped seam, where `inbox()` exists. Plus non-blocking note **N1**: clarify that no transplant file is edited to emit the §9.2 `onActivity` signal (tension with §9.1's "never edited" claim).

**Round 3** (LLD at 622 lines): F10 verified fixed — matrix ends Day-one → Inbox → Presence/Home; the register holds exactly its three amendments, cleanly separated. N1 verified folded — pool observes the transplanted scheduler at its existing call boundary; any needed emitter is an explicit R9 escalation, never an implicit edit. No undisclosed changes found. The author's line-count misstatement (625 vs 622) was self-caught and corrected (`[lld->adv 3b]`), independently confirmed by measurement.

**FINAL VERDICT: APPROVE** (issued `[adv->lld 5]`; gate artifact delivered to fe-coordinator `[adv->fe 11]`). Per charter R5 this approval gates Phase 2. Across three rounds and ten findings, no kind-branching defect, condemned-code harvest, seam leak, or C_min/floor violation was ever found — the failure classes that killed the prior attempts are structurally excluded by the registry-as-spine design, the import DAG, and the CI grep laws, and the honesty architecture (two-source liveness/pulse law, R7 disposition table, §10.7 register, D7/D9/D10 folds) is the document's strongest material.
## Two-account diff: R1 (seat 1, F-series + N1) × R1B (seat 2, B-series) — by seat 1, reviewer of record

Asymmetry stated first, so the comparison is honest: seat 2's pre-contamination discovery ran mostly against the 623-line POST-FIX text, where F1–F9 were already fixed — seat 2 never had the opportunity to independently find or miss most of the F-set. The diff therefore measures overlap and unique catches, not relative strength.

**Verbatim-agreement items (independent double discovery — strongest both-real signal):**
- F10 ≡ B5: the §10.7 table corruption / Inbox misfiled as a deferred seam amendment. Found independently by both seats against the same post-fix text, same mechanism, same fix. Also both accounts independently verified the same clean-attack set (condemned code, C_min, kinds totality, keyboard, routes, seam non-leakage) — corroborated disproofs, which are half the value.

**Partial overlap:**
- N1 (mine, non-blocking) ⊂ B8 (theirs, grounded): I flagged the §9.1 "never edited" vs §9.2 "derived inside the transplant boundary" tension and asked for an observe-don't-edit clarification; the author added it. B8 goes further and is RIGHT to: it verified against the tree that writeScheduler.ts exports NO event/observer API at all, so "write-scheduler flush events" names a mechanism that does not exist without editing the frozen file — and it names the actually-legal seam (the pool supplies the TerminalWriteTarget; wrapping that injected write sink observes flush activity with zero transplant edits). My N1 identified the tension; B8 identified the mechanism. B8's fix supersedes N1's sentence and the LLD should name the TerminalWriteTarget wrap explicitly.

**Unique to R1B — what seat 2 caught that I missed, with my miss-mechanism named:**
- B1 (MAJOR, real): WLT §3 "inline status/edit/complete" + row quick-actions have no ListConfig carrying field; §15.1's own matrix test cannot pass. MY MISS-MECHANISM: I verified the mapping in one direction only — every EXISTING field traces to a survival behavior — and never exhaustively walked every survival-list item INTO the schema. A 1:1 claim needs the walk in both directions; I checked the injective half and skipped the surjective half.
- B2 (real): §2.2 "adopted verbatim from SPEC-FINAL §4.5.2" is false after the consensus-forced deltas. MY MISS: I verified (and drove) the deltas but never re-read the word "verbatim" as a claim to attack.
- B3 (real, and a discipline lapse on my side): the catalog is 101 rows / 99 v1 + 2 reserved, not 101/98. MY MISS-MECHANISM is the worst of the set: my own grep returned ambiguous numbers (102/104), and I wrote "close enough; D8 binds the figure anyway" — deferring to a ledger snapshot over a fresh measurement, which is precisely the anti-pattern D8's own rationale names. Seat 2 measured properly and even ran down the false-positive grep hit.
- B4 (real): tokens.css lives at src/styles/tokens.css in the landed A0 tree, not src/kit/tokens.css as §1/§12/§14/§15.2 claim — so the CI hex-ban exemption names a nonexistent file. MY MISS-MECHANISM: I tree-verified every packages/ui harvest path but never diffed the LLD's claims about ITS OWN package against the landed A0 tree (the styles/ dir was in my very first ls).
- B6 (real): Phase-1 codec behavior for a valid-but-unavailable contentSurface chat token is unruled. MY MISS: I explicitly considered this area in Round 1 and skipped it as "fine for Phase 1" — the L8 property-test standard says an unruled behavior cannot be tested; my skip was wrong. Now ruled as D12 (preserve token, clamp presentation).
- B7 (real): the kind-literal-free mechanism for LiveSessionBar/roster session population is unnamed, inviting a CI-law violation as the builder's first instinct. MY MISS: I verified the liveness SOURCE but not the population mechanism against §15.2's grep law.

**Unique to R1 — what seat 1 caught that seat 2 could not have (pre-fixed before their pass):** F1 (behavior with no carrying API), F2 (superseded liveness field name vs the statusOf-only consensus), F3 (flows wired to ops absent from the stamped seam), F4 (seam-unservable fixture rows vs D7.2/R8), F5 (four R7 members hidden by omission), F6–F9. No claim these would have escaped seat 2 — they were gone from the text seat 2 attacked.

**Independence verdict:** the firewall earned its cost. Six real defects (B1–B4, B6–B7) survived my three rounds and fell to a second independent account within one pass; one defect (F10/B5) was double-discovered, upgrading its certainty; one (N1/B8) was found at two depths, and the deeper account wins. My misses cluster into three named mechanisms — one-directional verification of a bidirectional claim, deference to a ledger figure over an ambiguous fresh measurement, and verifying the oracle tree but not the target's own landed tree — all three are now attack-list items for Round 4.

---

# Round 4 — union verification and PROGRAM GATE VERDICT (appended by the reviewer of record)

Trigger: the firewalled second review (`LLD-REVIEW-R1B.md`) surfaced the B-series; fe-coordinator lifted the firewall and ordered the union verification (seat 1's union APPROVE = the program artifact). The two-account diff above records overlap, unique catches, and seat 1's named miss-mechanisms — which were then run as explicit Round-4 attack items.

**B-series dispositions, verified against the 636-line file text and the tree:**
- **B1 (MAJOR) FIXED** — `inlineEdit?: {status?, title?}` + `rowActions?: ActionRef[]` added to ListConfig; §3.1 renders both (capability-gated, same ActionRefs as panel/palette); §15.1 enumerates the closed 14-field vocabulary naming inline status/edit/complete explicitly. Verified by the FULL bidirectional survival-list walk: every WLT §3 item now lands on a named field.
- **B2 FIXED** — "Adapted from SPEC-FINAL §4.5.2 — with four named deltas" (all four accurate); no "verbatim" claim survives (grep 0 with positive control).
- **B4 FIXED at all five sites** — `src/styles/tokens.css` + `tokens-verbatim.test.ts` confirmed landed by ls; §1 map, §12, §14 (two sites), §15.2 all corrected; the CI hex-ban exclusion names the real file with the exempts-nothing rationale.
- **B7 FIXED** — §5.4 names the kind-literal-free population (seam liveness snapshot, live set = work_session ids by C-1, joined via domain-store selectors); the `query({kinds})` instinct named as a §15.2 build failure.
- **B8 FIXED and tree-verified** — writeScheduler.ts exports confirm NO event API and the injected `TerminalWriteTarget`; §9.2 now names the pool-supplied-target wrap as the sole observation point, zero transplant edits, R9-escalation clause standing. Supersedes seat 1's N1.
- **B3/B6 LEDGERED as D11/D12 and folded** — D11 re-measured fresh with its own commands (99 v1 + 2 real reserved = 101 rows, consistent); §10.3 cites the catalog as authority with the date-stamped measurement. D12 preservation-clamp present at §6 + §15.3 property test + §2.3 cross-reference.
- **B5 ≡ F10** — closed in Round 3.
- Off-scope sweep clean; header/§16 at D1–D12. Non-blocking note **N2**: `src/gallery/` (A0 dev gallery) unmentioned in the §1 module map — one line closes it; not gate-relevant.

## PROGRAM GATE VERDICT: **UNION APPROVE** (issued `[adv->lld 6]`, delivered `[adv->fe 15]`)

Coverage: F-series (10 findings, rounds 1–3) + B-series (8 findings, round 4) + D11/D12 folds + N1/N2. No blocking defect from either independent account survives. Two independent adversarial accounts, eighteen findings, four fix rounds, every disposition verified against file text and tree. Per charter R5, Phase 2 is gated open.
