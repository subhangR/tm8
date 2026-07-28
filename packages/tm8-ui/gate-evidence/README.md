# Gate evidence — provenance and supersession

Every capture: real Chrome ("Browser 2"), `http://127.0.0.1:4612/`, viewport 1492×812, fixture data. sha256 for each file is recorded in its committing message and in the reports cited below. Read this file first: five undated screenshots in a folder is exactly how the wrong one ends up in a gate package.

## CURRENT STATE (what the R5 review reviews)

| File | Taken | Shows |
|---|---|---|
| `T0-1-gate-light-final.jpg` | 2026-07-28 16:57 | Complete gate screen, light: empty-center roster + fixed filter row. sha256 `c87ad5f0…7494eb4f` |
| `T0-1-gate-dark-final.jpg` | 2026-07-28 16:57 | Same, dark. sha256 `826ba63e…2b9837dd` |

Capture record for the final pair: Browser 2, 1492×812, HEAD = 52a0751, three lanes green immediately before (tsc 0/0, 601 tests). Light and dark are from two loads, not one (a pre-hydration toggle click forced a re-navigation); fixture time is deterministic so the frames differ only by theme — verified by a differ-hash control (identical hashes would have exposed a silently failed toggle). The capturer's pre-committed served-state check ("Blocked" renders unclipped) was INAPPLICABLE to the remedy actually shipped (the row collapses to one trigger; the word no longer appears) — the real requirement (nothing overflows the column) was verified by direct observation instead, and this note records that the check that ran is not the check that was specified.

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
