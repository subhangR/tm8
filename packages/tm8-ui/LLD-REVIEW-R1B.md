# LLD Adversarial Review — R1B (independent second opinion)

**Reviewer:** LLD Adversary seat 2 (Fable-5), sess_1785218683236_d59zstxp1, task task_1785185030486_2my2voihe.
**Target:** `packages/tm8-ui/LLD.md` — reviewed at BOTH working-tree states seen this session: the 584-line pre-fix text (read at session start) and the **current 623-line post-fix text** (the author's R1 fix round landed mid-review; detected via the charter-R13 re-read discipline). All findings below are stated against the **current 623-line text**.
**Authority chain applied:** CHARTER.md R1–R15 → DECISIONS.md D1–D10 (re-read from file) → WLT v2.11 (uploads/08-SPECS copy; byte-identical to docs/architecture copy) → TM8-UI-SPEC-FINAL → 01/02 requirement docs → canvases (D4 set). Seam consensus: `src/data/LLD.md` §4.

## CONTAMINATION DISCLOSURE (required by fe-coordinator [fe->adv2 2])

- My independent verification pass and my findings B1–B4, B6, B7 were **fully formed and drafted BEFORE I opened `LLD-REVIEW-R1.md`**. I opened that file only because the Write tool's read-before-write guard blocked the destination my (since-superseded) brief named.
- I then read **R1.md in full, findings detail included** (F1–F9 + embedded coordinator rulings). Weight my agreement with R1 accordingly: after that point I could re-verify R1's findings but no longer independently *discover* them.
- Post-read work was: (a) re-reading the current LLD.md (which had been edited mid-session) and re-verifying each R1 finding against it myself, and (b) two findings **against the new fix-round text R1 has never seen** (B5, B8) — those are independent by construction.
- I have had no contact with the seat-1 adversary and will have none until round 2 closes.

## VERDICT: **REJECT** — 1 MAJOR, 7 MINOR (against the current 623-line text)

The architecture held every structural attack I ran (see "Attacks that failed"). All nine R1 findings verify as **RESOLVED** in the current text (my own re-verification, evidence below). What remains is one MAJOR that the LLD's own law convicts, plus seven small-edit MINORs — two of them introduced by the fix round itself. One more fix round should reach APPROVE.

---

## Findings (B-series, to avoid collision with R1's F-series)

### B1 — MAJOR — WLT §3 survival behavior "inline status/edit/complete" has NO ListConfig field; the LLD's own §15.1 test would fail *(pre-contamination)*
- **Violates:** WLT §3 ("behaviors ported as registry-driven capabilities with the explicit survival list: task current/completed sections, hierarchy expansion, **inline status/edit/complete**, Run/Coordinate primaries … **Re-homed, never dropped**"); LLD L2 + §2.2's own sentence ("every surviving behavior names its field; a behavior with no field is a spec defect"); FE brief Phase-0 bullet 1.
- **Evidence (current text):** §2.2 `ListConfig` fields are `sections, lifecycleTabs, tree, tile{badges,pulse}, liveCount, quickCreate, quickLaunch, primaryActions, filters, sort, needsAttentionGroup, liveTreatment` — none carries inline status-edit/title-edit/complete on list tiles, and §3.1's anatomy contains no inline-edit affordance: the behavior is **dropped**, not just field-less. §15.1 specifies "every WLT §3 survival behavior ↔ ListConfig field matrix" as a CI test — as designed, that test cannot pass. Related: §2.5 promises "list quick-actions" resolve through the ActionRef registry and §3.1 binds Terminate/complete as ActionRefs, but no ListConfig field declares which ActionRefs a kind's list rows carry (`primaryActions` is the header pair per its own comment). SPEC-FINAL §4.5.2 shares the hole, but WLT outranks it and the LLD owns the 1:1 claim.
- **Fix shape:** add carrying field(s) — e.g. `inlineEdit?: { status?: boolean; title?: boolean }` and `quickActions?: ActionRef[]` (task: complete; session: terminate/complete) — wire them into §3.1's anatomy and the §15.1 matrix. Any resolution that names a field per survival behavior is acceptable.

### B2 — MINOR — §2.2 "Adopted verbatim from SPEC-FINAL §4.5.2" is now false *(pre-contamination)*
The field set deliberately and CORRECTLY diverges from SPEC-FINAL (consensus-forced: `liveness` → `liveTreatment`, `needsAttentionGroup` gains the `SessionLiveness` param, `pulse` became the declarative two-source binding). "Verbatim" hides exactly the diff a reviewer must see. Say "adapted — with these named deltas" (three items, one line each).

### B3 — MINOR — "101 rows / 98 v1 ops" is stale against the tree *(pre-contamination)*
§10.3 asserts 101/98 "(ledgered as D8)". Measured this session: `grep -c "^  { name:" packages/contract/src/catalog.ts` = **101 rows**; among them **99 `status: 'v1'`** and **2 reserved** (`search.query`, `bridge.fetchBlob`); 101 − 2 = 99 confirms. `execution.liveness` not yet landed. Repeating a count snapshot is the exact anti-pattern D8's rationale names ("Counts go stale; the catalog is the authority"). Cite the catalog file; if a number is kept, date-stamp it.

### B4 — MINOR — tokens.css path contradicts the landed A0 tree *(pre-contamination)*
§1, §12, §14 and the §15.2 hex-ban exclusion all say `src/kit/tokens.css`. A0 landed **`src/styles/tokens.css`** (verified byte-equal to `05-DESIGN-SYSTEM/tokens.css`; `src/styles/tokens-verbatim.test.ts` exists). §14 claims its paths are "verified against the tree this session" — this one isn't. The CI hex-ban rule MUST name the real path or it exempts a nonexistent file.

### B5 — MINOR — §10.7 table corruption introduced by the fix round *(post-read; new-text defect R1 has not seen)*
The §10.7 register table is 4-column (`Deferred amendment | Consuming flow | Phase gate | Interim rendering`). Its last two rows — "| Inbox | … served by seam `inbox()` |" and "| Presence / Home | NOT fixture data … |" — are **2-cell rows that belong to the §10.6 dataset matrix** (they are its displaced `Inbox/home/presence` coverage rows). As placed, the table is malformed and "Inbox" reads as a deferred seam amendment even though `inbox()` **is in the stamped seam v1**. Move both rows back into the §10.6 matrix.

### B6 — MINOR — Phase-1 codec behavior for `contentSurface={id}:chat` is unruled *(pre-contamination)*
WLT §2.2: all four panel params round-trip. Phase 1 ships `contentSurfaces: ['terminal']` (§2.3, R10). A Phase-1 URL carrying `{id}:chat` is well-formed but names a surface the registry doesn't offer — §6 rules *unparseable* params only, not *valid-but-unavailable* values. Dropped, preserved, or coerced? L8's share/reload promise has an undefined case and §15.3's property tests can't test an unruled behavior. One sentence in §6 (recommend: preserve the token, render terminal — a Phase-2 link should not be lossy through a Phase-1 client) + a codec test; per §16 this is a D-entry candidate.

### B7 — MINOR — LiveSessionBar / empty-center roster: the kind-literal-free mechanism is unnamed *(pre-contamination)*
§15.2 fails the build on kind literals outside `domain/`/`fixtures/`, yet `shell/LiveSessionBar` ("N = ALL live work_sessions") and §5.2's empty-center roster need the work_session population. A compliant source exists — the seam liveness snapshot's live set IS work_session ids by C-1 definition, joined to summaries via domain-store selectors — but the LLD never names it, so a Phase-2 builder's first instinct (`query({kinds:['work_session']})` in shell code) violates the LLD's own CI law. One sentence in §5.4.

### B8 — MINOR — §9.2 `onActivity`'s stated mechanism does not exist in the verbatim module *(post-read; new-text defect R1 has not seen)*
§9.2 says the signal is "derived INSIDE the transplant boundary from **write-scheduler flush events**." Verified against the tree: `packages/ui/src/real/terminal/writeScheduler.ts` exposes **no event/observer API** — its exports are `initTerminalWriteScheduler(target)`, `queueTerminalOutput`, `dropTerminalOutput`, `flushTerminalOutput`; flushing happens via the injected `TerminalWriteTarget.getTerm(id).write(data)`. Since §9.1 freezes the transplant ("never edited"), "flush events" cannot be subscribed to without editing the verbatim file. A legal mechanism DOES exist and is already an injection seam: **the pool supplies the `TerminalWriteTarget`** — wrapping the `write` sink it hands the scheduler observes flush activity without touching transplant code or parsing bytes. Name that mechanism (or explicitly rule the hook as part of the allowed adaptation layer); as written the claim implies editing a frozen file.

---

## R1 findings re-verified against the current text (all RESOLVED)

| R1 | Status in current text | Evidence |
|---|---|---|
| F1 streaming source | RESOLVED | §2.2:120 declarative `pulse: {signal:'terminal-activity', gate:'live'}`; §9.2 `onActivity` (boolean, ~1s decay, live-gated); §5.4/§13/§10.6 all rewired ("streaming is not dataset data"). But see **B8** on the mechanism citation. |
| F2 liveness naming | RESOLVED | `liveTreatment` everywhere (§2.2, §3.1, §10.2.2); "the one liveness predicate is `seam.liveness.statusOf`". |
| F3 seam-surface mismatch | RESOLVED | §10.7 register (`handoffs.send/withdraw`, `spaces.menu.update`, `spaces.home`) with phase gates + interim disabled-with-reason; §8/§4.4/§10.5 cross-wired. But see **B5** (table malformed). |
| F4 unservable fixtures | RESOLVED | Presence/Home "NOT fixture data"; hollow/capability-gated renderings per D7. |
| F5 R7 completeness | RESOLVED | §4.2 disposition table: all R7 members homed incl. search-results-view, undo, version-history (`v{n}` footer), handoff-withdraw. |
| F6 header staleness | RESOLVED | R1–R15, D1–D10, §16 cites D5/D6/D9/D10 + R13–R15. |
| F7 startRouter | RESOLVED | §14 route-transport row: harvest ONLY :36-97; startRouter rebuilt fresh, old loop as pattern reference. |
| F8 contract names / channel slug | RESOLVED | §2.2 cites `CollectionQuery['filters']` member (verified: `CollectionFiltersSchema` in schemas.ts:464 is un-exported); §2.1 slug comment covers channel AND message. |
| F9 defaults / pool-test list | RESOLVED | §16 closes the 280/319 item; §15.7 lists the complete WLT §5.2a/c set with the Terminal→Chat→Terminal deferral named. |

## Attacks that failed (verified-clean, positive controls per R15)

1. **Condemned code:** `buildHash` (router.ts:170) condemned + never harvested; `MOUNTED_TERMINAL_LRU_SIZE=4` (CenterPane.tsx:24) condemned, pool floor 5 (C-2); `tm8Kinds.tsx`, TaskPanel/ResourcePanel markup, menu chrome, pixel oracle all condemned; CI grep specified.
2. **Tree citations:** nav.ts 228 LOC + MAX_PINNED=3; VirtualList 187; EntityPanel.tsx 427; SessionTerminal.tsx 512; RealFacade.ts 539; all transplant files + clipboard helpers; pty-protocol golden-frames test + fixture; useTasks/useSessions/queries/runTask/usePolledCollection/capabilities.ts; `promotePanel` stack-only gap real (nav.ts:143-147).
3. **Seam:** no leaks. §10 references (never restates) the stamped consensus; liveness only via `statusOf`, `unknown` neutral; no `availability(op)` probe; no parallel cache (domain-store ADOPTED); gate-critical list matches bridge §4 (11+3); `entityKinds` scope per §14 attachment; presence never synthesized; PTY stream correctly outside the seam (R9).
4. **Kind-branching:** only the declared strategy-branch in the codec; archetype table total over 15 kinds (matches `CoreEntityKindSchema` exactly) + `c:*` fallback; reader's format switch is a state switch.
5. **Floors/geometry:** C_min formula + table (320/320/648/976/1304) match WLT §5.2/02-LAYOUT; all L4 floors match 02-LAYOUT §6; defaults 280/319; peek ~440; demote-loop + C-3 stop state; pool `k−1` admission term.
6. **Routes/keyboard:** grammar, encodings, cap 2048, drop order, dedup pin>stack, redirect table — all verbatim vs WLT §2.2 + SPEC-FINAL §4.2.2–4.2.5. Keyboard: 6 layers, exclusion list, full `g` map, plain-`p`, physical `Ctrl+Backquote` inside `attachCustomKeyEventHandler`, zero-bytes + focus-landing tests — match WLT §5.8.
7. **Honesty:** R7 table complete; D7 three states in §10.3 + fixtures; two-facet law everywhere; D6/D9 fixture modeling exact; D10 named in §15.8.
8. **Completeness:** all nine FE-brief Phase-0 bullets covered. T0-4 canvas frames ("Z4 full views — 6 layouts", "Governed & fallback kinds", "Panel states") exist as cited.

## Required for APPROVE
B1 fixed (field + anatomy + §15.1 matrix row). B2–B8 fixed or explicitly ledgered (each ≤3 lines). I re-review the delta on request — targeted pass, not a full re-read.

---

## Round-2/3 disposition record (fe-coordinator [fe->adv2 3], 2026-07-28)

- **Contamination disclosure ACCEPTED** with weighting recorded: B1–B4/B6/B7 drafted pre-read; B5/B8 independent-by-construction against the post-fix text; `LLD-REVIEW-R1.md` unmodified by this seat.
- **B3 CONFIRMED** by the coordinator's own measurement (99 v1 + 2 reserved; the third whole-file `status: 'v1'` grep hit is a comment false-positive) — **ledgered as D11**, correcting D8's own stale figure.
- **B6 RULED as D12**: the codec PRESERVES a `contentSurface={id}:chat` token; presentation clamps to terminal, unflavored.
- **B1 verified real at the schema level** — routed to the LLD author as a round-4 MAJOR together with B2/B4/B7/B8. B5 (table corruption) also routed.
- **Process:** seat 1's firewall is lifted; seat 1 (reviewer of record) runs the two-account diff and round-4 verification; **seat 1's union APPROVE is the program artifact.** This seat stands down; available for corroborating delta-review of the B-set on request until round 2 closes.
