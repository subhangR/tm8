# R5 Gate Report — the T0-1 Master Screen

**Status:** FINAL. Capture HEAD = db18c95 — findings #1–#7 composed in one frame, both themes.
**Author:** fe-coordinator (sess_1785177979583_6diu9i7j1), 2026-07-28.
**Purpose:** the charter-R5 STOP package for USER review. Everything the reviewer needs is in this file or named by exact path from it.

---

## 1. The deliverable

The complete T0-1 workspace master screen — space tab bar, menu rail (data-driven, 220⇄48), both entity list panels, ink-stage center with live-session bar and the empty-center roster, panel-stack/pin engine, session panel with T0-2 terminal chrome (designed exited/static state) — **interactive on fixtures, both themes, rendering in a real browser.**

- **View it live:** `http://127.0.0.1:4612/` (vite, serving the repo tree; theme toggle via the account-menu control per D1).
- **Data:** fixture seam only (`createFixtureSeam` + `createDomainStore`); zero contact with :4610/:5442; the real transport exists behind the same seam as a type-enforced no-wire lane (bridge B3).

## 2. Evidence artifacts (in-repo, hashed)

`packages/tm8-ui/gate-evidence/` — **read its README.md first**; it names which captures are current, which are superseded history, and why the defect artifact is kept. Summary:

| File | Status | What it shows |
|---|---|---|
| `T0-1-gate-{light,dark}-final.jpg` | CURRENT | The complete gate screen for review: empty-center roster + fixed filter row, both themes |
| `T0-1-filter-row-postfix.jpg` | duplicate — see README | Byte-identical to the light-final (same capture, earlier name); README carries the identity note |
| `T0-1-gate-{light,dark}-empty-centre.jpg` | superseded | Roster landed; filter row still the old ten-chip clipped form |
| `T0-1-gate-{light,dark}-postfix.jpg` | superseded | Post liveness/rail fixes; center still blank |
| `T0-1-gate-dark-PREFIX-defect-evidence.jpg` | **defect artifact — read first** | The screen while all test lanes were green over two real defects; the only artifact that *shows* D10's argument |

All sha256 hashes are in the committing messages and the seat reports; the FINAL pair's hashes land with the packaging commit.

## 3. Coverage statement — read this before the numbers

**Real-browser RENDERING is proven; real-browser MEASUREMENT is not — this gate review performs it.**

- Proven: the assembled screen renders in a real Chrome (Browser 2), both themes; two integration defects were found *by the browser* and fixed (§4). All captures are from ONE viewport (1492×812) — no other width has been rendered, let alone measured.
- NOT yet performed (the review's work, D10): pixel-diff against the T0-1 canvas; measured floors and breakpoint transitions with worst-case content; the 9.5/10/11.5px micro-type at real rasterization; terminal keyboard-ownership proofs; per-platform Mod-chord receive tests.
- Test-lane state at packaging: whole package 601 tests / 30 files / both tsc lanes exit 0 — **logic-green**: independently re-measured by a non-author seat, whose caveat travels with the number: *nothing in those tests has measured a floor, a column width, a 9.5px pill, or a terminal.*

## 4. What the browser found that 493 green tests could not (the D10 proof)

1. **The screen contradicted itself on liveness.** The bar said "1 live" (reading the seam live set — correct); every session row said "not running" (reading a mislocated status field — wrong). Each half was internally consistent; only the composed screen exposed the disagreement. Fixed structurally (kind-literal-free `toSessionRow`). *No unit test could have caught it.*
2. **An honesty string destroyed its own slot.** The add-server reason, rendered inline in a 220px rail, wrapped to three lines and collided with its label (the same floor-inversion class as D34). Fixed: reason rides `aria-label`/`title` — reaches the user without printing into the floor.

Both defects are visible in the preserved pre-fix capture and absent in the post-fix pair.

## 5. The centerpiece exhibit: two-source honesty rendering on screen

The empty-center roster renders, on fixture data (scout row):

```
● scout   stale — node restarted    record: running
```

Verdict **beside** record — the record claims running, the liveness verdict says stale, and the UI shows both rather than collapsing them (D6/D7/D22 law; R-UI-5's one-predicate discipline; solid dots per D31; every status carries its word per C8/L10). "exited" and "failed" stay distinguishable instead of flattening to a single grey "not running."

## 6. Ruled divergences from the canvases — ruled, not missed

The ledger (`DECISIONS.md`, D1–D35; D1–D34 committed, D35 sweeps with this packaging commit) is the authority; the gate-relevant rulings:

- **D1** — no tab-bar ◐ theme toggle (T3-3 amendment supersedes the T0-1 pixels; theme lives in the account menu).
- **D15** — WLT's 8px column gaps supersede T0-1's flush columns (~16px wider chrome; the gap hosts the resize affordance).
- **D31 (+D22/D6)** — T1-1's pulsing collapsed-rail live dot is superseded: liveness-derived dots are SOLID; animation belongs exclusively to pool byte-activity. The collapsed live corner also renders its COUNT (C8/L10: status is color + word), extending the canvas's own badge-corner vocabulary to the row whose information was being dropped.
- **D33** — one tree guide-line formula (T0-3's four frames draw four different offsets; the reference card wins).
- **D12** — `contentSurface=…:chat` in URLs: preserved and clamped to terminal, unflavored (Phase-2 deep links authored today stay valid).
- **D5/D32** — canvas-measured literals kept verbatim where they fall outside token steps; disabled opacity follows what T1-4 *draws*, not its annotation.

## 7. Deferred and dormant — rendered honestly, never hidden

- **R7 register** (LLD §10.7): graph canvas, undo/version-history, handoff-withdraw, saved-views/axes management, search results — all disabled-with-reason; palette discovery rows DERIVED from `deferredActions()` so no hand-kept list can drift.
- **D7 day-one honesty states**: Home "load earlier" disabled-with-reason; presence/viewers hollow-value; provenance chips hollow until backend S2.
- **Terminal**: T0-2 chrome in its designed exited/static state; transport is the R9 verbatim transplant, wired at integration, not before.
- **Chat**: Phase-2; the `contentSurface` seam is reserved, sessions render unflavored terminal-only (CHAT §5.1).
- **Seam amendment register** (deferred, dual-consensus at integration): `handoffs.send`, `spaces.menu.update`, async `control.refused` channel.

## 8. Build provenance

- **LLD**: union-APPROVED across two independent adversarial accounts (4 rounds, 18 findings, all verified against file text; records in `LLD-REVIEW-R1.md`/`R1B.md`).
- **Commits**: `55d7471` (docs), `a78fca7` (A0), `0b01482`+`e6eaf33` (A1c), `7cf09ee` (A1a), `9f38b12` (A1b assembly, via R17 lock transfer during its stall), `6b1215f` (evidence), `edabc64` (empty-center), `1288b72` (evidence pair), `52a0751` (filter-row conformance + useDismissable; A1c). R5-iteration commits: `7963294` (findings 1-4), `5d674f7` (D36 keyboard), `841731d` (kind selector + theme persistence), `d806c90` (#5 dark shell), `2077dff` (#7 panel fills track), `db18c95` (D41 lifecycle field), `0dbf733` (D43 universal tiers). Final capture HEAD: `db18c95`. Bridge's data lane: `caabf74`, `58f8aad`, `160faa1`, `9d7ae1f`, `bbe1648`, `d4e1026`.
- **Quality mechanisms that paid**: the two-account review firewall (one MAJOR invisible to three single-account rounds); the no-branching guard (caught its own author); the class-sweep with planted controls (caught its own instrument twice); browser acceptance (§4); the stylesheet-source animation detector (allowlist empty); R17 commit ceremony (born from a live index race, then caught nothing because it worked).

## 9. The R5 iteration record (first review pass, 2026-07-28 afternoon)

The user's live review produced five findings; every one was classified ruled-or-defect against the ledger before any fix, root-caused before any patch, and fixed under gate-iteration authority. The full record:

| # | Finding (user's words condensed) | Classification | Root cause | Fix |
|---|---|---|---|---|
| 1 | Task rows are bare one-line titles | DEFECT | `tile.badges` had NO consumer — sessions looked complete only because they own the single field the renderer read | Badge renderer to the T0-1 1e anatomy + a consumer-coverage guard derived from the registry (`7963294`) |
| 2 | No in-panel search | DEFECT (omission) | The header was built from the spec's enumerated list; the element lives in T0-1's in-situ panels (T0-3 draws it nowhere — both measurements true, different frames) | T0-1's ⌕ row, client-side fixture filter, focus on `f` per D36 (`7963294`) |
| 3 | No view switcher | SPLIT: control = DEFECT; layout bodies = A2 scope | Same omission mechanism as #2 | Four-position control, unbuilt layouts disabled-with-reason, Graph per R7 (`7963294`) |
| 4 | Session panel: clipped duplicate banners; header pill green-"running" over a stale session | DEFECT (both halves) | The action bar used the caption honesty-form where T0-4 draws the tooltip form, AND was never handed the verdict/capabilities the panel held; the header pill read the record with no liveness awareness | Tooltip form + context injection; verdict-aware pill (`7963294`) |
| 5 | "Terminal should fully cover" — inset dark block, body sections on paper | SPLIT: dark shell = DEFECT; full-bleed = already correct | The composed canvas commits the WHOLE session body to the dark shell; the built panel wore paper around a correct dark canvas — the inset was the symptom, the neighbors were the defect. Provenance: an earlier ruling (D24) generalized a component frame over the composed canvas — the D38 error made before D38 existed; corrected append-only alongside the code fix | Dark shell via the D16 nested-theme mechanism, zero duplicated hex (`d806c90`; D40 corrects D24 append-only). Two laws this finding minted: *a region can look inset because it is inset, or because everything around it is the wrong colour — only measuring both tells you which* (the obvious reading measured clean; fixing it would have LOOKED fixed); and *a verification that passes identically before and after the fix is not a verification* (dark theme cannot prove the dark-shell law — the light-theme capture is the evidence) |

Plus two found by the fleet before the user could: the decorative kind selector (emitted, never handled — now real viewer-local state per LLD §11) and the unpersisted theme choice (reload silently discarded it — now the LLD §11 store with correct first paint). Both in `841731d`. The theme defect had been visible to two seats for hours — one documented it as a capture-procedure caveat, the other read it as a dead control: *a documented workaround reads like understanding, and that is exactly what stops it being re-examined.* It took two independent wrong explanations disagreeing to expose the behavior itself as the bug.

**The one mechanism behind findings 1 and 4, and the sentence the wave keeps:** *a consumer that has the authoritative fact available and renders a lesser one.* The precedence (verdict outranks record) is now stated once and applied at every consumer, with a registry-derived coverage guard so the next unconsumed source fails loud at authoring time (D39).

**Keyboard note the reviewer will meet:** search focuses on `f`, not the `/` the canvas hints — `/` is the palette's only browser-proof guarantee on half the support matrix, and a key hint is the contract advertising itself (D36/D37; the hint chip renders `f`).

Ledger growth this pass: D36–D40 (D40 corrects D24: a component frame had been generalized over the composed canvas — the D38 error class, committed before D38 was written). Evidence: the final capture set in `gate-evidence/` supersedes all earlier full-screen pairs — README carries the map.

### 9.1 How the iteration verified itself — the three-layer lesson

During this pass the verification signal itself failed three times, each layer differently, each caught by a seat auditing a sibling's fix (never its own first): (1) "617 tests passed" was TRUE and BLIND — a suite that fails to collect runs zero tests, and zero tests cannot lower a count; (2) the fix for that was exit-code-correct and INCOMPLETE — an interim scope enumerated from memory silently dropped two test files, including the tokens byte-equality acceptance gate, still exit 0; (3) the fix for THAT is exclusion over enumeration, because an exclude-form includes new directories automatically while a list cannot tell you when it is incomplete. The through-line, in the finding seat's words: *every one was verified against the author's INTENT and none against the SOURCE OF TRUTH — and in each case the correct check was cheap and available; nobody ran it until someone else's failure made them.* Standing rule adopted for every figure in this report: it states the command that produced it and the control proving the command could have failed. Current verified state: FE scope `bunx vitest run --exclude 'src/data/**'` = 20 files / 422 tests, exit 0, with the byte-equality test visibly executing in verbose output; the whole-package run is red only on an untracked bridge-lane spike (structural fix in flight, both runners verified before re-inclusion).

## 10. What the R5 review should do

1. Open `:4612`, both themes; interact: click→stack, Esc, `p`/pin with refusal copy, ⌘\ rail toggle, `/` palette, roster, drag-share visuals.
2. Diff the screen against `T0-1 Workspace Hi-Fi.dc.html` with §6's ruled divergences in hand — anything ELSE that diverges is a finding.
3. Review the DECISIONS ledger (D1–D34+) — R11 says the user reviews every ambiguity call at this gate.
4. Perform (or commission) the D10 measurement pass: floors, breakpoints, micro-type, worst-case UUID titles.
5. Verdict: fan-out approval (A2 per the brief), amendments, or rejection with findings — §9 shows the iteration loop is fast and honest; more findings are welcome input, not failures.
