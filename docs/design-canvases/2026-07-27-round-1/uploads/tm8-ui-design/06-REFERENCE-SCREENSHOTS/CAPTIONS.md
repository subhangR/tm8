# 06 — Visual reference

## What you are looking at

These are screenshots of **maestro** — the app tm8's workspace was transplanted from — captured live at **1600×1000 @2x**.

Maestro matters for one specific reason, and it is worth understanding before you design anything:

> **maestro's UI and tm8's design system are the same system.** Not similar — the same, ported. Measured off the running app and confirmed against maestro's own stylesheet:
>
> ```
> maestro redesign-tokens.css          tm8 tokens.css
>   --pn-paper:   #F4F2EC       ==       --pn-paper:   #F4F2EC
>   --pn-surface: #FBFAF6       ==       --pn-surface: #FBFAF6
>   --pn-line:    #E7E3D9       ==       --pn-line:    #E7E3D9
>   --pn-ink:     #23201B       ==       --pn-ink:     #23201B
>   --pn-brand:   #B26A2B       ==       --pn-brand:   #B26A2B
> ```

So these images are not "another app we admire." They are **the same design language, already at maturity**, showing what it looks like when a dense working surface is built in it. Treat them as the ancestor.

The lesson the project learned the hard way is recorded in `08-SPECS/PIXEL-TRANSPLANT-SPEC.md`: a previous rebuild used the correct tokens and still looked wrong, because it had *correct paint and no structure*. These screenshots are the structure half.

---

## The reference set — real maestro

| File | Shows |
|---|---|
| `00-full.png` | The whole app. **Start here.** Four regions: icon rail, left task panel, center terminal, right sessions/resources panel, with a full-width project tab bar above everything. |
| `01-topbar.png` | The project tab bar — 42px, full width. |
| `02-iconrail.png` | The far-left icon rail — 56px, with badge counts. |
| `03-left-panel.png` | The left task panel in full: header, counters, search, filter rows, grouping headers, per-row badges, status rings, avatars. |
| `04-left-header.png` | Crop of that panel's header — counters and the `run \| coordinate` control pair. |
| `05-right-panel.png` | The right panel: tabs with counts, agent avatar strip, state filters, live count, and the **nested session tree with guide lines**. |
| `06-right-header.png` | Crop of that panel's header and tab strip. |

## The comparison sets — what went wrong, and what "done" looked like

These are from the transplant effort. They are useful as a **quality bar**, because each pairs a build against its reference.

| File | Shows |
|---|---|
| `lane-a-target-*.png` | Left-panel targets — full view, header crop, panel crop. |
| `lane-a-*-side-by-side.png` | The left panel built vs. its reference, side by side. |
| `lane-b-target-*.png` | Right-panel targets — full, header, panel. |
| `lane-b-right-*-side-by-side.png` | The right panel built vs. its reference. |

The rule that came out of this: **a lane closes only on a side-by-side screenshot with an enumerated diff.** Type-checks and unit tests passed the entire first, wrong build — because the test environment has no layout engine and literally cannot see any of this.

---

## Two important cautions

**1. Do not treat these as the target design.** They are what tm8 ships *today*, and the new spec **replaces this layout**. The four bespoke panels collapse into two generic primitives. What survives from these images is the *density, the visual language, and the behavior inventory* — not the pane structure.

**2. The center terminal is not a design target.** It is a verbatim transplant of maestro's terminal, including its streaming internals, and is being kept exactly as-is by explicit direction. Designable: the thin chrome strip above it, and the panel around it. Not designable: the terminal canvas itself.
