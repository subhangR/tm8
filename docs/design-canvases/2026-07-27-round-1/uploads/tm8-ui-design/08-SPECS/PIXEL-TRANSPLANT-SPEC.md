# Pixel Transplant — the actual job, restated

**Author:** Atlas · **Date:** 2026-07-25 · **Status:** binding, supersedes WORKSPACE-TRANSPLANT-PLAN.md §5 lane acceptance

---

## 0. Why this document exists

The first build was rejected by the user: *"you had one job, to do the exact ui transplant. wtf is this."*

He is right. The failure was mine and it was a verification failure, not an implementation one. Every browser pass I ran asserted **wiring** — does the row count match the server, does the write persist, is the unavailable affordance disabled. Not one of them asked whether the result **looked like maestro**, with the reference application running on the same machine the entire time.

The blueprint's framing — *"this is a mount-and-fill job, not a port"* — is what turned "exact UI transplant" into "compose surfaces that already work". That framing was wrong for this brief, and I helped write it.

**What we shipped vs. what maestro is:**

| | maestro | first build |
|---|---|---|
| Left | project header, `+ New task`, `91 / 0 / 601 / 33` counters, search + ⌘K, `All \| High \| Overdue \| Status`, `Priority` + `Sort` + filter count, `run \| coordinate` pair, `IN PROGRESS · 82` grouping, per-row `MED`/`HIGH` badges, status rings, avatars | 7 filter chips, a text input, flat rows of title + status pill |
| Centre | full-bleed dark terminal | light empty box |
| Right | `Sessions 4 \| Resources` tabs, `+`, `99+`, agent avatar strip, sub-tabs with counts (`Terminals`, `Agents 3`, `Docs 66`, `Drawings 5`), state filters (`Open 3 / Done 13 / Archived 42 / Huddles 39`), `● 4 live`, 3-level session tree with guide lines and `ARCHIVED`/`DONE` badges | 32 identical rows, every one clipped to `Se…` |
| Chrome | full-width project tab bar, 56px icon rail with badge counts | none |

---

## 1. THE FINDING THAT CHANGES THE JOB

**maestro's shipping UI and tm8's `collab-v2/tokens.css` are the same design system.** Not similar — the same, ported.

Measured off the running app (`.pn-rail` → `#F4F2EC`, `.appLeftPanelContent` → `#FBFAF6`, hairline → `#E7E3D9`) and confirmed in source at `maestro-ui/src/components/maestro/redesign/redesign-tokens.css`:

```
maestro redesign-tokens.css          tm8 collab-v2/tokens.css
  --pn-paper:   #F4F2EC       ==       --pn-paper:   #F4F2EC
  --pn-surface: #FBFAF6       ==       --pn-surface: #FBFAF6
  --pn-line:    #E7E3D9       ==       --pn-line:    #E7E3D9
  --pn-ink:     #23201B       ==       --pn-ink:     #23201B
  --pn-brand:   #B26A2B       ==       --pn-brand:   #B26A2B
```

Same "Atelier" warm-paper theme, same type scale, same spacing ramp, same radii.

**And `redesign-tokens.css` is not only tokens — it carries the whole `pn-*` COMPONENT layer**, with the exact numbers already written down. That makes the port more mechanical than "read the values off the reference": for the chrome, the stylesheet is largely liftable as-is and the work is markup + data rewiring. Worked examples, all verbatim from that file:

```
.pn-top      height 42px, gap 12px, padding 0 14px, bg --pn-paper, 1px --pn-line bottom
.pn-ptab     height 27px, padding 0 11px, radius --pn-r-sm, 12.5px/500, --pn-ink-3
.pn-ptab--active   bg --pn-card, --pn-ink, border --pn-line, 600, --pn-sh-sm
.pn-rail     width 56px, padding 12px 0 10px, gap 4px, 1px --pn-line right
.pn-rail-btn 40×40, radius 10px; --active::before = 3px brass bar, left -12px, inset 10px
.pn-rail-badge  min-width 15px, height 15px, radius 8px, --pn-ink on --pn-paper, mono 9px/600
```

If a value you need is not in this file, it is in the panel's own stylesheet. It is never yours to choose.

**Therefore: this is a PORT, not a redesign.** Nobody invents a layout, picks a colour, or chooses a size. You lift maestro's `pn-*` component markup and CSS and repoint its data at the tm8 facade. If you find yourself choosing a padding value, you are doing it wrong — go read the number out of maestro's stylesheet.

That is also why the first build looks wrong despite using the right tokens: correct paint, no structure.

---

## 2. Ground truth — use it, every time

The reference app is running and screenshottable:

```
http://127.0.0.1:4575          maestro-ui, VITE_APP_MODE=browser, proxying the live server on :4570
```

Started with (from `maestro-ui/`):
```
VITE_APP_MODE=browser MAESTRO_DEV_API_PROXY=http://127.0.0.1:4570 \
  bunx vite --port 4575 --strictPort --host 127.0.0.1
```
A fresh browser profile hits a first-run onboarding modal — click through the `Next` buttons and it is gone.

Captured reference, committed beside this doc in `docs/ui/audit/reference/`:

| file | what |
|---|---|
| `00-full.png` | whole app, 1600×1000 @2x |
| `01-topbar.png` | project tab bar |
| `02-iconrail.png` | 56px icon rail |
| `03-left-panel.png` / `04-left-header.png` | P2 |
| `05-right-panel.png` / `06-right-header.png` | P4 |

**The target under test is `http://127.0.0.1:4611/#/s/{space}/workspace`.** Same viewport, same crops, side by side.

---

## 3. What is being kept

The wiring is sound and the user is not objecting to it. **Do not rewrite it.**

- `RealFacade` for every query — never a hand-built body (`collections.query` is `.strict()` server-side)
- `expectedVersion` on every write; `completerIds` on complete
- `capabilities.ts` degradation — unbuilt reads captioned, unbuilt writes disabled-with-reason
- `usePolledCollection` — one poll per data class, shared by query key
- the grid floors and derived breakpoint in `workspace.css` (STATE.md:136)
- `real/terminal/*` and `SessionTerminal.tsx` remain **read-only for every lane**

What changes is the surface above it.

---

## 4. Lanes — by panel, file-disjoint, all workers codex `gpt-5.6-sol`

Every lane follows the same loop: **read the maestro source → port markup + CSS → repoint data at the tm8 facade → screenshot your panel → diff against the reference crop → iterate until it matches.**

### Lane A — P2, the left task panel

Port from:
```
maestro-ui/src/components/maestro/MaestroPanel.tsx        853 LOC  header, counters, search, filter rows, grouping
maestro-ui/src/components/maestro/ExecutionBar.tsx        539 LOC  the run | coordinate pair
maestro-ui/src/components/maestro/SortableTaskList.tsx    157 LOC  row list + section headers
maestro-ui/src/styles-maestro-panel.css
maestro-ui/src/styles-left-panel.css
maestro-ui/src/styles-maestro-panel-tabs.css
maestro-ui/src/components/maestro/redesign/redesign-tiles.css   .pn-stat and friends
```
Into `packages/ui/src/real/workspace/{TaskPanel.tsx, task-panel.css}`; keep `useTasks.ts` as the data layer.

Panel width is **280px** (measured, not chosen).

Data mapping — every counter must be a real query, never a placeholder: open/pinned/done/archived counts from `collections.query` with `filters.workStatus`; `IN PROGRESS · N` grouping from `workStatus`; priority badge from `state.priority`. Anything with no tm8 backing (pinning, archive) is rendered **disabled-with-reason** via `Unavailable.tsx`, never dropped and never faked.

### Lane B — P4, the right sessions/resources panel

Port from:
```
maestro-ui/src/components/SessionsSection.tsx     1823 LOC   the whole panel
maestro-ui/src/components/maestro/SessionListItem.tsx
maestro-ui/src/styles-maestro-sessions-v2.css
```
Into `packages/ui/src/real/workspace/{ResourcePanel.tsx, tabs/*, resource-panel.css}`; keep `useSessions.ts` / `queries.ts`.

Panel width **~319px**. Required: the `Sessions | Resources` top tabs with counts, the agent avatar strip, sub-tabs with counts, the `Open / Done / Archived / Huddles` state filters, the `● N live` indicator, and the **nested session tree with guide lines** — that tree is the single biggest visual gap and it is the point of the panel.

The current 32 clipped `Se…` rows are the exact failure this lane exists to fix: read STATE.md:136 before writing a single flex rule.

### Lane C — P3 centre + app chrome

- Centre pane: full-bleed **dark** terminal surface. Today it is a light empty box; maestro's is near-black edge to edge with no chrome when idle. Keep the one-terminal / keyed-by-sessionId invariants.
- `IconRail` — port `maestro-ui/src/components/IconRail.tsx` (78) + `styles-icon-rail.css`; 56px, badge counts.
- Project tab bar — port from `SpacesRail.tsx` (252). tm8 has **no equivalent at all** today. Where tm8 has no concept behind an affordance, caption it; do not invent one.

---

## 5. The bar for "done" — this is the part that failed last time

A lane is **not** complete on typecheck + vitest. Those passed last time and the UI was wrong.

A lane is complete when:

1. `bunx tsc --noEmit` clean and the lane's vitest passes, **and**
2. the worker has captured its panel at 1600×1000 and put it **beside the reference crop**, and
3. **Atlas has done that diff and accepted it.**

Report to Atlas with the screenshot path. "It renders" is not a report. "Here is my panel next to `04-left-header.png`, the differences are X, Y, Z, and here is why each remains" is a report.

jsdom has no layout engine. It cannot see any of this. It never could.
