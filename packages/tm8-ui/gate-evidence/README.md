# Gate evidence — provenance and supersession

Every capture: real Chrome ("Browser 2"), `http://127.0.0.1:4612/`, viewport 1492×812, fixture data. sha256 for each file is recorded in its committing message and in the reports cited below. Read this file first: five undated screenshots in a folder is exactly how the wrong one ends up in a gate package.

## CURRENT STATE (what the R5 review reviews)

| File | Taken | Shows |
|---|---|---|
| `T0-1-gate-light-final.jpg` | 2026-07-28 17:56, HEAD `db18c95` | THE review frame, light: findings #1–#7 composed — lifecycle tabs + footers both panels, empty-center roster with the verdict-beside-record pair, one-chip filter row, clean rail. sha256 `5fe82b35…6625d557` |
| `T0-1-gate-dark-final.jpg` | 2026-07-28 17:56, HEAD `db18c95` | Same, dark — theme persisted-on-load proving 841731d in the capture itself. sha256 `aeff07ff…a913fe7c` |

Capture record for the final pair: Browser 2, 1492×812, HEAD = db18c95, FE-scope 444 tests exit 0 + both tsc lanes 0 at shoot time (package app-lane red only on bridge's in-flight itest files, known and theirs). Superseded intermediates from the R5 iteration (the 16:57 pair, the r5-findings-1-4 light, the session-dark-shell detail) remain as history rows below. Light and dark are from two loads, not one (a pre-hydration toggle click forced a re-navigation); fixture time is deterministic so the frames differ only by theme — verified by a differ-hash control (identical hashes would have exposed a silently failed toggle). The capturer's pre-committed served-state check ("Blocked" renders unclipped) was INAPPLICABLE to the remedy actually shipped (the row collapses to one trigger; the word no longer appears) — the real requirement (nothing overflows the column) was verified by direct observation instead, and this note records that the check that ran is not the check that was specified.

## SECOND ITERATION (R5 continued — findings #8–#10, the Run workflow, and the fifth layer)

| File | Taken | Shows |
|---|---|---|
| `sessions-corrected-feea2f6.jpg` | 2026-07-28 23:19, HEAD `feea2f6` | The corrected lifecycle tiers after the D57 fifth-layer fix (rowsFor binds its filter): Open lists ONLY the two live-ish sessions, Done holds the two exited ones — disjoint sets, header total 4, sums honestly. Also documents (free evidence) the pre-parity brand-outline `+ New` chip, dated BEFORE for the ink-chip fix at d877d83. Dark theme, A1c certified, sha256 `a88f09ec…7df53` |

## PARITY CYCLE (user-ruled, D58/D60 — the current visual state)

| File | Taken | Shows |
|---|---|---|
| `parity-dark-3ae3aa0.jpg` | 2026-07-29 00:14, HEAD `3ae3aa0`, hard reload | THE parity headline: dark paper on the canvas's #1D1912 (was #15130E), 1.1× user-ruled scale, ink create chips. sha256 `e27e3e31…6774` |
| `parity-light-3ae3aa0.jpg` | 2026-07-29 00:14, HEAD `3ae3aa0`, hard reload | Light: ink `+ New`/`+ Launch` chips (BEFORE is the brand-outline in `sessions-corrected-feea2f6.jpg`), soft sibling-row hairlines, 1.1× scale. sha256 `5da2ad78…28fe` |

Differ-hash: distinct (asserted from comparison, not from having clicked a toggle). Framing document: `PARITY-LEDGER.md` at `18886c2`+ — read it WITH these; the pre-correction copy in `64cbf80` understates what these frames show (status rot, corrected with provenance).

**FIGURE QUARANTINE.** The session total in `T0-1-r5-7-session-path-verified.jpg` (the "12 → 15" movement) is an artifact of the fifth-layer defect — every lifecycle-tiered kind was triple-counted by a discarded filter (all three tiers received the same array). The true movement is **4 → 5 sessions**. The LIVE-set movement 1 → 2 in the same frame is real and stands: liveIds is seam-sourced and never passed through the defective path (verified, not assumed, by A1c before certifying). Do not cite that frame's totals; cite its live-set movement only.

## SUPERSEDED (kept as history; do not review against these)

| File | Taken | Shows | Superseded by |
|---|---|---|---|
| `T0-1-gate-light-empty-centre.jpg` | 2026-07-28 ~16:45 | Empty-center roster landed; filter row still OLD (ten flat-mapped chips, clipped, sort chip pushed out) | FINAL pair |
| `T0-1-gate-dark-empty-centre.jpg` | 2026-07-28 ~16:45 | Same, dark | FINAL pair |
| `T0-1-gate-light-postfix.jpg` | 2026-07-28 ~13:14 | Post liveness/rail-footer fixes; center still blank | empty-centre pair |
| `T0-1-gate-dark-postfix.jpg` | 2026-07-28 ~13:14 | Same, dark | empty-centre pair |

## DETAIL EVIDENCE (component-scoped, current)

| File | Taken | Shows |
|---|---|---|
| `T0-1-filter-row-postfix.jpg` | 2026-07-28 ~16:52 | **Byte-identical to `T0-1-gate-light-final.jpg` (same sha256)** — the same full-screen capture under two names; A1c committed it in 52a0751 five minutes before the final-pair naming existed. Do not compare the two "against" each other. Its capture was preceded by the live picker-dismissal verification and deliberately re-shot so the evidence shows the committed state |

## DEFECT ARTIFACT (deliberately preserved — read it first)

| File | Taken | Shows |
|---|---|---|
| `T0-1-gate-dark-PREFIX-defect-evidence.jpg` | 2026-07-28 ~13:10 | The screen while every unit-test lane reported green over two real defects: session rows reading "not running" under a "1 live" bar (self-contradicting screen) and the rail footer destroyed by its own honesty string. This is the only artifact in the program that *shows* D10's argument — that jsdom-green is not layout acceptance — rather than asserting it. |

## TREE COLLAPSED BY DEFAULT (2026-08-17 ruling)

Captured from `/e2e/tree-collapse-harness.html` — the real `EntityListPanel`
with the shipping stylesheets, over a synthesised three-deep task chain (the
fixture seam has no same-kind hierarchy: its sessions are parented to TASKS, so
in any single-kind list every parent is off-page and the tree measures flat).

| File | sha256 | Shows |
|---|---|---|
| `tree-collapsed-by-default.png` | `f4829e0d1829cdcbb4054fb938018ffff29d8f72f188fe0f08b0e852d6385ea7` | The shipped landing state: ONE root tile, its two children shut, and the chevron **visible at 0.55** saying so |
| `tree-expanded-after-two-clicks.png` | `0009dd945b1d6c32d92af070b96231852e2fab41cd2d2f8d1115b2ab5626e347` | Root then Mid opened by hand — guide lines, 17px indent per level, rotated chevrons, `Leaf task` at depth 2 |

**What the browser caught that jsdom could not.** The first capture of this pair
showed a row with two hidden children and NO affordance anywhere on screen:
`.pn-tt__arrow` and `.lp__disclosure` were `opacity: 0` until hover. The vitest
suites were green throughout — the control is in the DOM with a real 16px box
either way, and jsdom loads no stylesheets. That is D10's argument again, and
the fix is the `opacity: 0.55` rule `.pn-st__arrow` had already adopted for
exactly this reason one file over.
