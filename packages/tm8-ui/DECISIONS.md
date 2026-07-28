# tm8-ui Decisions Ledger

Per charter R11: every design-ambiguity call made during the build is logged here by the fe-coordinator or its workers. The user reviews this ledger at THE GATE. Entries are append-only, numbered, dated, with source and rationale. Do not renumber or rewrite closed entries; corrections get a new entry referencing the old one.

Format:

```
## D<N> — <title> (<date>)
Source: <who ruled / where it came from>
Ruling: <the decision>
Rationale: <why, citing ATELIER / WLT / canvas>
```

---

## D1 — Tab-bar ◐ theme toggle is RETIRED (2026-07-28)

Source: Round-2 design-compliance review, ALL-ACCEPT verdict, forwarded by master coordinator. Amendment lives in T3-3's prose and binds the shell build.

Ruling: Do NOT build the ◐ theme toggle in the space tab bar, even though the T0-1 canvas still renders it (canvas is byte-unchanged; the amendment supersedes the pixels). Theme's one home is the account menu (T3-3); the command palette keeps "toggle theme" as the fast path.

Rationale: T3-3 (Account Menu, Round 2) retires the tab-bar toggle; single-home discipline for theme control.

## D2 — Board "axis: status ▾" grouping picker is IN-SCOPE (2026-07-28)

Source: Round-2 design-compliance review, boundary confirmation, forwarded by master coordinator.

Ruling: T5-2's board-layout grouping picker ("axis: status ▾") IS built — a board cannot render without its axis. What stays deferred under charter R7 is the saved-views/axes persistence-management surface, which no canvas draws.

Rationale: Distinguishes the in-canvas board control (required for the Board collection layout) from the deferred saved-views feature; R7's "disabled-with-reason, never hidden" applies only to the latter.

## D3 — Four detail-panel tabs everywhere; T5-7 three-tab mocks are abbreviation (2026-07-28)

Source: Round-2 design-compliance review, T5-7 nit, forwarded by master coordinator.

Ruling: EntityDetailPanel always renders four tabs (Content / Discussion / Connections / Activity), fixed order, every kind, no exceptions. Two small T5-7 mocks (empty-state panel, one 320px UUID mock) showing three tabs are mock abbreviation, not design; the prose reaffirms the four-tab law.

Rationale: WLT §3 / TM8-UI-SPEC-FINAL §4.6.2 inherited Z3 anatomy; the reviewer confirmed the mocks do not amend it.

## D4 — Canonical composition references (2026-07-28)

Source: Round-2 reviewer remark, forwarded by master coordinator.

Ruling: T5-2 (Board/Feed/Gallery layouts), T5-5/T5-6 (Launch & Authoring flows), and T5-3 (Doc Authoring) are especially tight and are treated as canonical composition references when other canvases are ambiguous.

Rationale: Reviewer's explicit guidance; gives ambiguity-resolution precedence within the canvas suite.

## D5 — Kit keeps canvas-measured literals that sit outside the named token steps (2026-07-28)

Source: A0 foundation worker, extracting kit primitives from T0-1 / T0-3 / T0-4.

Ruling: Colors are ALWAYS tokens (no hex in kit.css beyond what tokens.css defines). Geometry and micro-type literals measured from the canvases are kept verbatim even where they fall between the named token steps: mono micro sizes 9.5px (status pills) / 10px (section eyebrows, filter pills) / 11.5px (edge chips), the 6px radius on edge chips and kbd hints (between --pn-r-xs 5 and --pn-r-sm 7), and the agent-avatar 5px radius at EVERY size including 32px (T0-1 Z4: avR = member ? '50%' : '5px').

Rationale: The charter makes the canvases ground truth and the A0 brief says "match the canvases, do not invent styling". Normalizing these to the token scale would visibly drift from the approved pixels; ATELIER §6's "may not break the radii set" binds the designer's new work, and these values are the approved design's own output.

## D6 — Fixture vocabulary for the stale-session honesty state (2026-07-28)

Source: A0 foundation worker, fixture dataset design.

Ruling: Fixtures model a "stale" work session as `state.status === 'running'` with an activityAt well in the past (sessionStale, last heard 11:05 against FIXTURE_NOW 12:00) — there is no invented `stale` status and no fake liveness field on the contract shape. The honesty derivation ("running per record · unverified", no live dot) belongs to the UI layer once the charter-R3 liveness read exists; until then a running record without liveness proof must never render as live.

Rationale: Charter R3/R8 keep liveness detection out of this program's fixtures; inventing a non-contract field would leak a fake seam. The contract already expresses the honest truth: the record claims running, and recency is the only evidence available.
