# Pixel-parity ledger — build vs T0-1 hi-fi oracle

**Oracle:** `T0-1 workspace structure review (1)/T0-1 Workspace Hi-Fi.dc.html` (171,229 bytes) — the file the user reviews.
**Method:** source-to-source enumeration, not sampling and not a screenshot diff. **D10's real-browser pixel pass still has not been run and this ledger does not substitute for it.**
**Status:** pass 1 (colour/type/spacing inventory) + pass 2 (surface-by-surface application) complete. Fixes prepared, uncommitted.

---

## The two findings that change what should be fixed

### A — the type scale is NOT drifting, and the obvious fix would make parity worse

Every `font-size` literal in the oracle, against every one in our owned stylesheets. **The value sets are identical** for every size the oracle uses on a built surface:

```
oracle  8.5 9 9.5 10 10.5 11 11.5 12 12.5 13 14 14.5 15   (+15.5 16 17 17.5 18 19 24 27)
ours    8 8.5 9 9.5 10 10.5 11 11.5 12 12.5 13 14 14.5 15 16
```

Every oracle size ≥15.5px is Newsreader serif on Z4/EntityFullView surfaces (`{{zc.title}}`, `{{zc.desc}}`, `{{c.desc}}`, `{{st.v}}`, `{{c.init}}`) — **A2 fan-out, not built**. Unimplemented surface, not divergence.

So "letters are too small" is a **uniform-scale** question: the canvas presents fit-to-width on claude.ai (`present=1`) while the app renders 1:1, so the same 10px reads larger there.

> **Do not fix this per element.** It would destroy the parity that currently exists and violate **D5**, which rules the canvas-measured micro sizes (9.5 / 10 / 11.5px) as verbatim keepers. And no lever exists today: no root `font-size` is set anywhere, and type is px literals plus `--pn-fs-*` tokens that are themselves px. A uniform scale is a **new root decision**. Escalated to the user.

### B — dark paper: the oracle never paints our value

| | value |
|---|---|
| oracle dark stage | `#1D1912` |
| ours (`--pn-paper` dark) | `#15130E` |
| occurrences of `#15130E` in the oracle | **0** |

The oracle uses `#1D1912` twice, both product surface:
- `<!-- CENTER: ink stage --> <div style="flex:1;…;background:#1D1912">`
- `zBg: dk ? '#1D1912' : '#F4F2EC'` — paired with `#F4F2EC`, which **is** our light `--pn-paper`. So `#1D1912` is the oracle's dark counterpart of paper.

**Why it went uncaught:** `src/styles/canvas-extra.css:29-30` classified it as *"demo 'board' behind every canvas frame: presentation scaffolding, not a product surface. Never shipped."* That is wrong — it is the ink stage. A correct-sounding comment closed the question.

**Not ours to fix.** `tokens.css` is a byte-verbatim transplant under a byte-equality test, so this is a **canvas-versus-token-file conflict between two design sources**. Escalated to the user; the byte-equality test moves only *with* the ruling, in the same commit, as one fact.

---

## 1. Colours — full enumeration (43 hex literals; not sampled)

**32 of 43 map exactly to our tokens**, light and dark — paper/surface/card/hover/active/line/line-2, the four-step ink ramp, brand/brand-2, and run/wait/block/info in both themes. **The palette is not the problem.** Remaining differences are *application*, the dark-paper conflict, and the few below.

### RULED — cite and move on
| oracle | home | ruling |
|---|---|---|
| `#131009` | `--pn-x-term-live-bg` | D23 |
| `#0D0B08` | `--pn-x-term-bg` | D23 |
| `#4A4334` | `--pn-x-term-ghost` | D23 |
| `#FFF8EC` | `--pn-x-warn-fill` | D23 |
| `#3A362E` | `--pn-x-btn-ink-hover` | D23 — `.lp__new` application FIXED-IN-FLIGHT (fe) |
| always-dark regions | nested dark scope, ramp not restated | D24 |
| `9.5 / 10 / 11.5px`, 6px chip radius, 5px avatar radius | canvas-measured keepers | D5 |
| oracle ≥15.5px serif | Z4 surface, unbuilt (A2) | not drift |

### DRIFT — no ruling covered these
| oracle | ours | where | disposition |
|---|---|---|---|
| `#F0EDE4` ×15, row divider | `--pn-line` `#E7E3D9` | `panels.css` 561 / 689 / 970 | **FIXED (prepared)** |
| `#1D1912` ink stage | `--pn-paper` dark `#15130E` | `tokens.css` | **user ruling — Finding B** |
| `#E89A89` Terminate hover | none | — | **FIXED (prepared)** |
| oracle floor `8.5px` | `8px` | `shell.css` 293, 316 | **FIXED (prepared)** |
| oracle smallest radius `3px` | `2px` | `shell.css` 282 | **FIXED (prepared)** |

### OUT OF FE SCOPE — Track P owns `src/terminal/**`
`#B9B2A0` ×8 and `#7FBF98` ×6 — terminal scrollback text and success-line colours. Listed so they are not re-derived as FE drift.

---

## 2. Pass 2 — surface-by-surface application

The pass-1 result (palette matches) forced the real question: *which token on which element*. One rule explains every divider in the oracle:

> **`--pn-line` BOUNDS a component. The soft hairline SEPARATES siblings inside one.**

Evidence, from the oracle's own inline styles:

- `#E7E3D9` on **component edges** — panel header (`background:#FBFAF6;border-bottom:1px solid #E7E3D9`), chip/pill borders (`border:1px solid #E7E3D9;border-radius:6px|7px|8px|999px`), cards, and rules bracketing a meta block.
- `#F0EDE4` on **sibling rows only** — always `border-bottom`, always inside a repeated list: tiles carrying `border-left:2px solid {{s.bar}}`, field rows at `padding:6px 10px`, activity rows at `padding:7px 0`.
- Site 15 names the concept and its dark pair: `zHair: dk ? '#262117' : '#F0EDE4'` — and `#262117` **is** dark `--pn-hover`, exactly.

Applied accordingly — **3 selectors change, 5 deliberately do not**:

| our selector | oracle counterpart | result |
|---|---|---|
| `.lp__tile` (970) | tile row w/ `border-left:2px` | → soft hairline |
| `.pn-fields__row` (561) | `padding:6px 10px` row | → soft hairline |
| `.pn-activity__row` (689) | `padding:7px 0` row | → soft hairline |
| `.pn-section` (15), `.pn-ctxhead` (51), `.pn-head` (309), `.pn-actions` (349), `.pn-tabs` (406) | component edges | **stay `--pn-line`** |

---

## 3. Spacing / radii — coarse

```
oracle  6(36) 999(31) 8(29) 7(18) 5(14) 10(8) 4(7) 3(5)
ours    6(13) 8(9) 5(8) 7(4) 4(4) 3(2) 2(1)  + --pn-r-pill 999 / --pn-r-md 10 via tokens
```
Radii match the canvas set apart from the single 2px (fixed). D5 already rules the 6px and 5px keepers.

---

## Not checked, and saying so

- **`.lq__launch`** (sheet commit, brand amber, `panels.css:1301`) answers to **T5-5**, not this oracle. Not diffed — ruling on a surface against the wrong reference file is worse than not ruling.
- **Real-browser rendering.** All of the above is source-to-source. D10's pixel pass remains un-run.
- **Four phantom colours excluded:** `#212`, `#219`, `#217`, `#208` are PR numbers in fixture text, not colours.
